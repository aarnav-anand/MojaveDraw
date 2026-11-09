import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
import { newImageElement } from "@excalidraw/element";
import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { BinaryFileData, BinaryFiles, DataURL, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

// Configure pdfjs worker using Vite's URL import
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export interface PdfPageRenderResult {
  fileId: FileId;
  fileData: BinaryFileData;
  width: number;
  height: number;
  pageNumber: number;
}

export interface PdfImportProgress {
  currentPage: number;
  totalPages: number;
}

/**
 * Converts a PDF File into an array of rendered image pages
 */
export const convertPdfToImages = async (
  pdfFile: File,
  doc: Document,
  onProgress?: (progress: PdfImportProgress) => void,
  renderScale: number = 2.0, // 2x for sharp retina text and diagrams
): Promise<PdfPageRenderResult[]> => {
  const arrayBuffer = await pdfFile.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdfDocument = await loadingTask.promise;
  const totalPages = pdfDocument.numPages;

  const results: PdfPageRenderResult[] = [];

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    onProgress?.({ currentPage: pageNum, totalPages });

    const page = await pdfDocument.getPage(pageNum);
    const viewport = page.getViewport({ scale: renderScale });

    // Use ownerDocument provided by caller per AGENTS.md guidelines
    const canvas = doc.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error(`Failed to get canvas 2d context for page ${pageNum}`);
    }

    // Render white background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: ctx,
      viewport,
      canvas,
    }).promise;

    const dataURL = canvas.toDataURL("image/png") as DataURL;
    const fileId = `pdf_${Date.now()}_p${pageNum}_${Math.random().toString(36).slice(2, 7)}` as FileId;

    const fileData: BinaryFileData = {
      id: fileId,
      dataURL,
      mimeType: "image/png",
      created: Date.now(),
      lastRetrieved: Date.now(),
    };

    // Calculate normal display width/height at scale 1.0 (CSS pixels)
    const baseViewport = page.getViewport({ scale: 1.0 });

    results.push({
      fileId,
      fileData,
      width: baseViewport.width,
      height: baseViewport.height,
      pageNumber: pageNum,
    });
  }

  return results;
};

/**
 * Inserts converted PDF pages onto the active Excalidraw canvas
 * stacked vertically and locked by default for easy annotation
 */
export const insertPdfIntoCanvas = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  doc: Document,
  pdfFile: File,
  onProgress?: (progress: PdfImportProgress) => void,
): Promise<void> => {
  const pages = await convertPdfToImages(pdfFile, doc, onProgress);
  if (!pages.length) {
    return;
  }

  // Add all binary image files into Excalidraw's file registry
  const filesToAdd: BinaryFileData[] = pages.map((p) => p.fileData);
  excalidrawAPI.addFiles(filesToAdd);

  const appState = excalidrawAPI.getAppState();
  const currentElements = excalidrawAPI.getSceneElements();

  // Position pages at current scroll position or centered
  const startX = -appState.scrollX + (appState.width - pages[0].width) / 2;
  let currentY = -appState.scrollY + 100;
  const pageSpacing = 40;

  const newElements: ExcalidrawElement[] = [];

  for (const page of pages) {
    const imageElement = newImageElement({
      type: "image",
      x: startX,
      y: currentY,
      width: page.width,
      height: page.height,
      fileId: page.fileId,
      status: "saved",
      locked: true, // Locked so user can draw, highlight, and annotate freely over it
      customData: { isPdf: true, pdfFileName: pdfFile.name },
    });

    newElements.push(imageElement);
    currentY += page.height + pageSpacing;
  }

  // Update canvas scene with new elements
  excalidrawAPI.updateScene({
    elements: [...currentElements, ...newElements],
    appState: {
      errorMessage: null,
    },
  });

  // Scroll into view
  if (newElements[0]) {
    excalidrawAPI.setViewport({
      target: newElements[0],
      fit: "scale-down",
      animation: true,
    });
  }
};

/**
 * Checks whether the given elements contain any PDF-rendered pages
 */
export const hasPdfInCanvas = (elements: readonly ExcalidrawElement[]): boolean => {
  return elements.some(
    (el) =>
      !el.isDeleted &&
      el.type === "image" &&
      (el.fileId?.startsWith("pdf_") || (el.customData as any)?.isPdf),
  );
};

/**
 * Deletes all PDF pages from the Excalidraw canvas
 */
export const deletePdfFromCanvas = (
  excalidrawAPI: ExcalidrawImperativeAPI,
): { deletedCount: number } => {
  const elements = excalidrawAPI.getSceneElements();
  const pdfFileIds = new Set<string>();
  const remainingElements: ExcalidrawElement[] = [];

  for (const el of elements) {
    if (
      el.type === "image" &&
      (el.fileId?.startsWith("pdf_") || (el.customData as any)?.isPdf)
    ) {
      if (el.fileId) {
        pdfFileIds.add(el.fileId);
      }
    } else {
      remainingElements.push(el);
    }
  }

  const deletedCount = elements.length - remainingElements.length;
  if (deletedCount > 0) {
    excalidrawAPI.updateScene({
      elements: remainingElements,
    });
  }

  return { deletedCount };
};
