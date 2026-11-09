import { createStore, get, set, del, entries } from "idb-keyval";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { STORAGE_KEYS } from "../app_constants";
import {
  isSupabaseConfigured,
  getSupabaseUser,
  saveDocumentToSupabase,
  fetchDocumentsFromSupabase,
  deleteDocumentFromSupabase,
} from "./supabase";

export interface DocumentMetadata {
  id: string;
  title: string;
  thumbnail?: string;
  createdAt: number;
  updatedAt: number;
  syncedToCloud?: boolean;
}

export interface ExcalidrawDoc extends DocumentMetadata {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files?: BinaryFiles;
}

const docsStore = createStore("excalidraw-documents-db", "documents");
const metaStore = createStore("excalidraw-documents-db", "documents-meta");

const ACTIVE_DOC_STORAGE_KEY = "excalidraw_active_doc_id";

export const generateDocId = (): string => {
  return "doc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
};

export const getActiveDocIdFromUrl = (): string | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const hash = window.location.hash;
  const match = hash.match(/^#doc=([a-zA-Z0-9_-]+)/);
  if (match) {
    return match[1];
  }
  return null;
};

export const setActiveDocIdToUrl = (id: string) => {
  if (typeof window === "undefined") {
    return;
  }
  localStorage.setItem(ACTIVE_DOC_STORAGE_KEY, id);
  const currentHash = window.location.hash;
  // If we are currently on a collab room, don't clobber room hash
  if (currentHash.startsWith("#room=")) {
    return;
  }
  window.history.replaceState(null, "", `#doc=${id}`);
};

export const getActiveDocumentId = (): string => {
  const fromUrl = getActiveDocIdFromUrl();
  if (fromUrl) {
    return fromUrl;
  }
  const fromStorage = typeof window !== "undefined" ? localStorage.getItem(ACTIVE_DOC_STORAGE_KEY) : null;
  return fromStorage || "default";
};

/**
 * Migrates existing data from window.localStorage to IndexedDB.
 * This frees up the 5MB browser localStorage and resolves the
 * "Browser storage quota exceeded" issue permanently.
 */
export const migrateFromLocalStorageIfNeeded = async (): Promise<ExcalidrawDoc | null> => {
  try {
    const rawElements = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS);
    const rawState = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE);

    if (rawElements) {
      const elements = JSON.parse(rawElements);
      const appState = rawState ? JSON.parse(rawState) : {};

      const defaultDoc: ExcalidrawDoc = {
        id: "default",
        title: "My First Drawing",
        elements: Array.isArray(elements) ? elements : [],
        appState: appState || {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await saveDocument(defaultDoc);

      // Clear legacy localStorage keys to free up the 5MB quota!
      try {
        localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS);
        localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE);
      } catch (e) {
        console.warn("Could not remove legacy storage keys:", e);
      }

      return defaultDoc;
    }
  } catch (error) {
    console.error("Migration from localStorage failed:", error);
  }
  return null;
};

export const listDocuments = async (): Promise<DocumentMetadata[]> => {
  try {
    // 1. Fetch from local IndexedDB
    const localMetas: DocumentMetadata[] = [];
    const metaEntries = await entries(metaStore);
    for (const [, value] of metaEntries) {
      if (value && typeof value === "object") {
        localMetas.push(value as DocumentMetadata);
      }
    }

    // Sort descending by updated time
    localMetas.sort((a, b) => b.updatedAt - a.updatedAt);

    // 2. If Supabase is connected and user is logged in, merge cloud documents
    if (isSupabaseConfigured) {
      const user = await getSupabaseUser();
      if (user) {
        const cloudDocs = await fetchDocumentsFromSupabase();
        const mergedMap = new Map<string, DocumentMetadata>();

        for (const meta of localMetas) {
          mergedMap.set(meta.id, meta);
        }

        for (const cloudDoc of cloudDocs) {
          const cloudUpdatedAt = new Date(cloudDoc.updated_at).getTime();
          const existing = mergedMap.get(cloudDoc.id);

          if (!existing || cloudUpdatedAt > existing.updatedAt) {
            const meta: DocumentMetadata = {
              id: cloudDoc.id,
              title: cloudDoc.title,
              thumbnail: cloudDoc.thumbnail_url || undefined,
              createdAt: new Date(cloudDoc.created_at).getTime(),
              updatedAt: cloudUpdatedAt,
              syncedToCloud: true,
            };
            mergedMap.set(cloudDoc.id, meta);
            // Cache to local meta store as well
            await set(cloudDoc.id, meta, metaStore);
          }
        }

        const mergedList = Array.from(mergedMap.values());
        mergedList.sort((a, b) => b.updatedAt - a.updatedAt);
        return mergedList;
      }
    }

    return localMetas;
  } catch (error) {
    console.error("Failed to list documents:", error);
    return [];
  }
};

export const loadDocument = async (id: string): Promise<ExcalidrawDoc | null> => {
  try {
    // 1. Try IndexedDB
    const localDoc = await get<ExcalidrawDoc>(id, docsStore);
    if (localDoc) {
      return localDoc;
    }

    // 2. If not found locally, try Supabase if configured
    if (isSupabaseConfigured) {
      const user = await getSupabaseUser();
      if (user) {
        const cloudDoc = await fetchDocumentsFromSupabase().then((docs) =>
          docs.find((d) => d.id === id),
        );
        if (cloudDoc) {
          const doc: ExcalidrawDoc = {
            id: cloudDoc.id,
            title: cloudDoc.title,
            elements: cloudDoc.elements,
            appState: cloudDoc.app_state,
            thumbnail: cloudDoc.thumbnail_url || undefined,
            createdAt: new Date(cloudDoc.created_at).getTime(),
            updatedAt: new Date(cloudDoc.updated_at).getTime(),
            syncedToCloud: true,
          };
          await saveDocument(doc, false); // Cache locally
          return doc;
        }
      }
    }

    // 3. Fallback to localStorage migration if id is default
    if (id === "default") {
      const migrated = await migrateFromLocalStorageIfNeeded();
      if (migrated) {
        return migrated;
      }
    }

    return null;
  } catch (error) {
    console.error("Failed to load document:", error);
    return null;
  }
};

export const saveDocument = async (
  doc: Partial<ExcalidrawDoc> & { id: string },
  syncCloud: boolean = true,
): Promise<void> => {
  try {
    const existing = (await get<ExcalidrawDoc>(doc.id, docsStore)) || null;

    const fullDoc: ExcalidrawDoc = {
      id: doc.id,
      title: doc.title || existing?.title || "Untitled Drawing",
      elements: doc.elements || existing?.elements || [],
      appState: doc.appState || existing?.appState || {},
      thumbnail: doc.thumbnail !== undefined ? doc.thumbnail : existing?.thumbnail,
      files: doc.files || existing?.files,
      createdAt: existing?.createdAt || doc.createdAt || Date.now(),
      updatedAt: Date.now(),
      syncedToCloud: existing?.syncedToCloud || false,
    };

    // Save full document to IndexedDB
    await set(fullDoc.id, fullDoc, docsStore);

    // Save lightweight metadata to index store
    const meta: DocumentMetadata = {
      id: fullDoc.id,
      title: fullDoc.title,
      thumbnail: fullDoc.thumbnail,
      createdAt: fullDoc.createdAt,
      updatedAt: fullDoc.updatedAt,
      syncedToCloud: fullDoc.syncedToCloud,
    };
    await set(fullDoc.id, meta, metaStore);

    // Async sync to Supabase if configured and logged in
    if (syncCloud && isSupabaseConfigured) {
      getSupabaseUser().then((user) => {
        if (user) {
          saveDocumentToSupabase({
            id: fullDoc.id,
            title: fullDoc.title,
            elements: fullDoc.elements,
            appState: fullDoc.appState,
            thumbnail: fullDoc.thumbnail,
            files: fullDoc.files,
          }).then((success) => {
            if (success) {
              fullDoc.syncedToCloud = true;
              meta.syncedToCloud = true;
              set(fullDoc.id, fullDoc, docsStore);
              set(fullDoc.id, meta, metaStore);
            }
          });
        }
      });
    }
  } catch (error) {
    console.error("Failed to save document:", error);
  }
};

export const createDocument = async (title?: string): Promise<ExcalidrawDoc> => {
  const id = generateDocId();
  const doc: ExcalidrawDoc = {
    id,
    title: title || "Untitled Drawing",
    elements: [],
    appState: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveDocument(doc);
  return doc;
};

export const duplicateDocument = async (id: string): Promise<ExcalidrawDoc | null> => {
  const source = await loadDocument(id);
  if (!source) {
    return null;
  }
  const newId = generateDocId();
  const newDoc: ExcalidrawDoc = {
    ...source,
    id: newId,
    title: `${source.title} (Copy)`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    syncedToCloud: false,
  };
  await saveDocument(newDoc);
  return newDoc;
};

export const deleteDocument = async (id: string): Promise<boolean> => {
  try {
    await del(id, docsStore);
    await del(id, metaStore);

    if (isSupabaseConfigured) {
      deleteDocumentFromSupabase(id).catch(console.error);
    }
    return true;
  } catch (error) {
    console.error("Failed to delete document:", error);
    return false;
  }
};
