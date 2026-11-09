import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  listDocuments,
  loadDocument,
  saveDocument,
  createDocument,
  duplicateDocument,
  deleteDocument,
  getActiveDocumentId,
  setActiveDocIdToUrl,
} from "../data/documentStore";
import type { DocumentMetadata } from "../data/documentStore";
import {
  isSupabaseConfigured,
  getSupabaseUser,
} from "../data/supabase";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  PlusIcon,
  TrashIcon,
  DuplicateIcon,
  searchIcon,
  pencilIcon,
  checkIcon,
  exportToFileIcon,
} from "@excalidraw/excalidraw/components/icons";

import "./DocumentsDashboard.scss";

// ---------------------------------------------------------------------------
// NewDrawingDialog — inline naming prompt shown before a doc is created
// ---------------------------------------------------------------------------
interface NewDrawingDialogProps {
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export const NewDrawingDialog: React.FC<NewDrawingDialogProps> = ({
  onConfirm,
  onCancel,
}) => {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-focus the input as soon as the dialog mounts
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConfirm(name.trim() || "Untitled Drawing");
  };

  return (
    <div
      className="new-drawing-dialog-overlay"
      onClick={onCancel}
    >
      <div
        className="new-drawing-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-drawing-title"
      >
        <h3 id="new-drawing-title">Name your drawing</h3>
        <p>Give this drawing a name so you can find it later.</p>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            className="new-drawing-name-input"
            placeholder="e.g. Architecture Diagram, Meeting Notes…"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                onCancel();
              }
            }}
          />
          <div className="new-drawing-dialog-actions">
            <button type="button" className="btn-cancel" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn-create">
              ✏️ Create &amp; Open
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface DocumentsDashboardProps {
  isOpen: boolean;
  onClose: () => void;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  onOpenAuthModal?: () => void;
}

export const DocumentsDashboard: React.FC<DocumentsDashboardProps> = ({
  isOpen,
  onClose,
  excalidrawAPI,
  onOpenAuthModal,
}) => {
  const [documents, setDocuments] = useState<DocumentMetadata[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeDocId, setActiveDocId] = useState<string>(getActiveDocumentId());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [showNewDrawingDialog, setShowNewDrawingDialog] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  const fetchDocs = useCallback(async () => {
    const list = await listDocuments();
    setDocuments(list);
    setActiveDocId(getActiveDocumentId());

    if (isSupabaseConfigured) {
      const user = await getSupabaseUser();
      setUserEmail(user?.email || null);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchDocs();
    }
  }, [isOpen, fetchDocs]);

  if (!isOpen) {
    return null;
  }

  /** Open the naming dialog */
  const handleCreateNew = () => {
    setShowNewDrawingDialog(true);
  };

  /** Called when the user confirms a name in the dialog */
  const handleConfirmNewDrawing = async (name: string) => {
    setShowNewDrawingDialog(false);

    // Save the current active document before switching away
    if (excalidrawAPI) {
      const currentElements = excalidrawAPI.getSceneElements();
      const currentAppState = excalidrawAPI.getAppState();
      const currentFiles = excalidrawAPI.getFiles();
      await saveDocument({
        id: activeDocId,
        elements: currentElements,
        appState: currentAppState,
        files: currentFiles,
      });
    }

    // Create the new named document — saveDocument already pushes to Supabase
    const newDoc = await createDocument(name);
    setActiveDocIdToUrl(newDoc.id);
    setActiveDocId(newDoc.id);

    if (excalidrawAPI) {
      excalidrawAPI.resetScene();
      excalidrawAPI.updateScene({
        elements: [],
        appState: {
          name: newDoc.title,
        },
      });
    }

    onClose();
  };

  const handleOpenDoc = async (id: string) => {
    if (id === activeDocId) {
      onClose();
      return;
    }

    // Save current active document before switching
    if (excalidrawAPI) {
      const currentElements = excalidrawAPI.getSceneElements();
      const currentAppState = excalidrawAPI.getAppState();
      const currentFiles = excalidrawAPI.getFiles();
      await saveDocument({
        id: activeDocId,
        elements: currentElements,
        appState: currentAppState,
        files: currentFiles,
      });
    }

    const doc = await loadDocument(id);
    if (doc && excalidrawAPI) {
      setActiveDocIdToUrl(id);
      setActiveDocId(id);

      // Add files if present
      if (doc.files) {
        excalidrawAPI.addFiles(Object.values(doc.files));
      }

      excalidrawAPI.updateScene({
        elements: doc.elements || [],
        appState: {
          ...doc.appState,
          name: doc.title,
        } as any,
      });
    }

    onClose();
  };

  const handleDuplicate = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const copy = await duplicateDocument(id);
    if (copy) {
      await fetchDocs();
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const confirmed = window.confirm("Are you sure you want to delete this drawing?");
    if (!confirmed) {
      return;
    }

    await deleteDocument(id);
    // If the active doc was deleted, switch to another or create new
    if (id === activeDocId) {
      const remaining = documents.filter((d) => d.id !== id);
      if (remaining.length > 0) {
        await handleOpenDoc(remaining[0].id);
      } else {
        await handleCreateNew();
      }
    }
    await fetchDocs();
  };

  const handleStartRename = (e: React.MouseEvent, doc: DocumentMetadata) => {
    e.stopPropagation();
    setEditingId(doc.id);
    setEditTitle(doc.title);
  };

  const handleSaveRename = async (e: React.SyntheticEvent, id: string) => {
    e.stopPropagation();
    if (!editTitle.trim()) {
      setEditingId(null);
      return;
    }
    await saveDocument({ id, title: editTitle.trim() });
    setEditingId(null);
    await fetchDocs();
  };

  const handleExportDoc = async (e: React.MouseEvent, docMeta: DocumentMetadata) => {
    e.stopPropagation();
    const doc = await loadDocument(docMeta.id);
    if (!doc) {
      return;
    }

    const exportPayload = {
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements: doc.elements || [],
      appState: doc.appState || {},
      files: doc.files || {},
    };

    const json = JSON.stringify(exportPayload, null, 2);
    const blob = new Blob([json], { type: "application/vnd.excalidraw+json" });
    const url = URL.createObjectURL(blob);
    const ownerDoc = modalRef.current?.ownerDocument || document;
    const a = ownerDoc.createElement("a");
    a.href = url;
    a.download = `${doc.title || "drawing"}.excalidraw`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const text = reader.result as string;
        const parsed = JSON.parse(text);
        if (parsed.elements && Array.isArray(parsed.elements)) {
          const newDoc = await createDocument(
            file.name.replace(/\.excalidraw$/i, "") || "Imported Drawing",
          );
          await saveDocument({
            id: newDoc.id,
            title: newDoc.title,
            elements: parsed.elements,
            appState: parsed.appState || {},
            files: parsed.files || {},
          });
          await fetchDocs();
          await handleOpenDoc(newDoc.id);
        }
      } catch (err) {
        console.error("Invalid excalidraw file:", err);
        window.alert("Invalid .excalidraw file format.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const filteredDocs = documents.filter((d) =>
    d.title.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const formatRelativeTime = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) {
      return "Just now";
    }
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  return (
    <>
      {showNewDrawingDialog && (
        <NewDrawingDialog
          onConfirm={handleConfirmNewDrawing}
          onCancel={() => setShowNewDrawingDialog(false)}
        />
      )}
      <div
        className="documents-dashboard-overlay"
        onClick={onClose}
      >
      <div
        className="documents-dashboard-modal"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="dashboard-header">
          <div className="header-title-section">
            <h2>
              <span>📁</span> My Drawings
            </h2>
            <span className="doc-count-badge">{documents.length}</span>
          </div>

          <div className="header-actions">
            {isSupabaseConfigured && (
              <button
                type="button"
                className={`btn-supabase-status ${userEmail ? "synced" : ""}`}
                onClick={onOpenAuthModal}
                title={userEmail ? `Synced to Supabase (${userEmail})` : "Connect Supabase Account"}
              >
                <span>{userEmail ? "☁️ Synced" : "☁️ Connect Cloud"}</span>
              </button>
            )}

            <button
              type="button"
              className="btn-new-drawing"
              onClick={handleCreateNew}
            >
              {PlusIcon}
              <span>New Drawing</span>
            </button>

            <button
              type="button"
              className="btn-close-dashboard"
              onClick={onClose}
              title="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="dashboard-toolbar">
          <div className="search-box">
            <span>{searchIcon}</span>
            <input
              type="text"
              placeholder="Search drawings..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="toolbar-right">
            <label className="btn-import-file">
              <span>Import .excalidraw</span>
              <input
                type="file"
                accept=".excalidraw,application/json"
                style={{ display: "none" }}
                onChange={handleImportFile}
              />
            </label>
          </div>
        </div>

        {/* Documents Grid / Content */}
        <div className="dashboard-content">
          {filteredDocs.length === 0 ? (
            <div className="dashboard-empty-state">
              <div className="empty-icon">🎨</div>
              <h3>
                {searchQuery ? "No drawings match your search" : "No drawings yet"}
              </h3>
              <p>
                {searchQuery
                  ? "Try searching for a different name."
                  : "Create multiple drawings, organize your notes, and annotate PDFs seamlessly."}
              </p>
              {!searchQuery && (
                <button type="button" onClick={handleCreateNew}>
                  + Create First Drawing
                </button>
              )}
            </div>
          ) : (
            <div className="documents-grid">
              {filteredDocs.map((doc) => {
                const isActive = doc.id === activeDocId;
                const isEditing = editingId === doc.id;

                return (
                  <div
                    key={doc.id}
                    className={`document-card ${isActive ? "active-doc" : ""}`}
                    onClick={() => handleOpenDoc(doc.id)}
                  >
                    <div className="card-preview">
                      {doc.thumbnail ? (
                        <img src={doc.thumbnail} alt={doc.title} />
                      ) : (
                        <div className="card-placeholder">
                          <span>✏️</span>
                          <span>Excalidraw Drawing</span>
                        </div>
                      )}

                      <div className="card-badges">
                        {isActive && <span className="badge-active">ACTIVE</span>}
                        {doc.syncedToCloud && (
                          <span className="badge-cloud" title="Synced with Supabase">
                            CLOUD
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="card-info">
                      <div className="card-title-row">
                        {isEditing ? (
                          <input
                            type="text"
                            className="title-edit-input"
                            value={editTitle}
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setEditTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                handleSaveRename(e, doc.id);
                              } else if (e.key === "Escape") {
                                setEditingId(null);
                              }
                            }}
                            onBlur={(e) => handleSaveRename(e, doc.id)}
                          />
                        ) : (
                          <span className="card-title" title={doc.title}>
                            {doc.title}
                          </span>
                        )}

                        {isEditing ? (
                          <button
                            type="button"
                            onClick={(e) => handleSaveRename(e, doc.id)}
                          >
                            {checkIcon}
                          </button>
                        ) : (
                          <button
                            type="button"
                            title="Rename"
                            onClick={(e) => handleStartRename(e, doc)}
                          >
                            {pencilIcon}
                          </button>
                        )}
                      </div>

                      <div className="card-meta-row">
                        <span>{formatRelativeTime(doc.updatedAt)}</span>

                        <div className="card-actions">
                          <button
                            type="button"
                            title="Duplicate"
                            onClick={(e) => handleDuplicate(e, doc.id)}
                          >
                            {DuplicateIcon}
                          </button>
                          <button
                            type="button"
                            title="Export to .excalidraw"
                            onClick={(e) => handleExportDoc(e, doc)}
                          >
                            {exportToFileIcon}
                          </button>
                          <button
                            type="button"
                            className="delete-btn"
                            title="Delete"
                            onClick={(e) => handleDelete(e, doc.id)}
                          >
                            {TrashIcon}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
};
