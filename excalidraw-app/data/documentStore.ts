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
  fetchFoldersFromSupabase,
  saveFolderToSupabase,
  deleteFolderFromSupabase,
} from "./supabase";

export interface FolderItem {
  id: string;
  name: string;
  parentId: string | null; // null if top-level / root
  createdAt: number;
  updatedAt: number;
  syncedToCloud?: boolean;
}

export interface DocumentMetadata {
  id: string;
  title: string;
  folderId?: string | null; // null if root
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

// ---------------------------------------------------------------------------
// Separate IndexedDB stores (each store in its own database to avoid
// IDB multi-store schema versioning conflicts)
// ---------------------------------------------------------------------------
const docsStore = createStore("excalidraw-docs-db-v2", "documents");
const metaStore = createStore("excalidraw-meta-db-v2", "metadata");
const foldersStore = createStore("excalidraw-folders-db-v2", "folders");

// Legacy database store for migration
const legacyDocsStore = createStore("excalidraw-documents-db", "documents");

const ACTIVE_DOC_STORAGE_KEY = "excalidraw_active_doc_id";

// ---------------------------------------------------------------------------
// In-Memory Cache (Guarantees instant UI updates without waiting for IDB disk)
// ---------------------------------------------------------------------------
const memoryDocs = new Map<string, ExcalidrawDoc>();
const memoryMeta = new Map<string, DocumentMetadata>();
const memoryFolders = new Map<string, FolderItem>();
let isInitialized = false;

// Store change subscribers
type StoreListener = () => void;
const listeners = new Set<StoreListener>();

export const subscribeToStoreChanges = (listener: StoreListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const notifyStoreChanged = () => {
  listeners.forEach((cb) => {
    try {
      cb();
    } catch (e) {
      console.error("Store listener error:", e);
    }
  });
};

export const generateDocId = (): string => {
  return "doc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
};

export const generateFolderId = (): string => {
  return "fld_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
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

// ---------------------------------------------------------------------------
// INITIALIZATION & MIGRATION
// ---------------------------------------------------------------------------
const initializeStoresIfNeeded = async () => {
  if (isInitialized) {
    return;
  }
  isInitialized = true;

  try {
    // 1. Load local metadata into memory
    const metaEntries = await entries(metaStore).catch(() => []);
    for (const [, value] of metaEntries) {
      if (value && typeof value === "object") {
        const item = value as DocumentMetadata;
        memoryMeta.set(item.id, item);
      }
    }

    // 2. Load local folders into memory
    const folderEntries = await entries(foldersStore).catch(() => []);
    for (const [, value] of folderEntries) {
      if (value && typeof value === "object") {
        const item = value as FolderItem;
        memoryFolders.set(item.id, item);
      }
    }

    // 3. Migrate from legacy "excalidraw-documents-db" if needed
    try {
      const legacyEntries = await entries(legacyDocsStore).catch(() => []);
      for (const [, value] of legacyEntries) {
        if (value && typeof value === "object") {
          const doc = value as ExcalidrawDoc;
          if (!memoryMeta.has(doc.id)) {
            const meta: DocumentMetadata = {
              id: doc.id,
              title: doc.title || "Untitled Drawing",
              folderId: doc.folderId || null,
              thumbnail: doc.thumbnail,
              createdAt: doc.createdAt || Date.now(),
              updatedAt: doc.updatedAt || Date.now(),
              syncedToCloud: doc.syncedToCloud,
            };
            memoryMeta.set(doc.id, meta);
            await set(doc.id, doc, docsStore).catch(console.warn);
            await set(doc.id, meta, metaStore).catch(console.warn);
          }
        }
      }
    } catch (e) {
      // Legacy db might not exist or be empty, ignore
    }

    // 4. Migrate from localStorage if needed (e.g. fresh installation)
    await migrateFromLocalStorageIfNeeded();
  } catch (error) {
    console.error("Failed to initialize stores:", error);
  }
};

// ---------------------------------------------------------------------------
// FOLDERS MANAGEMENT
// ---------------------------------------------------------------------------

export const listFolders = async (): Promise<FolderItem[]> => {
  await initializeStoresIfNeeded();

  try {
    // Check Supabase if configured and logged in
    if (isSupabaseConfigured) {
      const user = await getSupabaseUser();
      if (user) {
        const cloudFolders = await fetchFoldersFromSupabase();
        for (const cf of cloudFolders) {
          const cfUpdatedAt = new Date(cf.updated_at).getTime();
          const existing = memoryFolders.get(cf.id);

          if (!existing || cfUpdatedAt >= existing.updatedAt) {
            const item: FolderItem = {
              id: cf.id,
              name: cf.name,
              parentId: cf.parent_id || null,
              createdAt: new Date(cf.created_at).getTime(),
              updatedAt: cfUpdatedAt,
              syncedToCloud: true,
            };
            memoryFolders.set(cf.id, item);
            set(cf.id, item, foldersStore).catch(console.warn);
          }
        }
      }
    }

    const list = Array.from(memoryFolders.values());
    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  } catch (error) {
    console.error("Failed to list folders:", error);
    return Array.from(memoryFolders.values());
  }
};

export const createFolder = async (
  name: string,
  parentId?: string | null,
): Promise<FolderItem> => {
  await initializeStoresIfNeeded();

  const id = generateFolderId();
  const folder: FolderItem = {
    id,
    name: name.trim() || "New Folder",
    parentId: parentId || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Immediate in-memory cache update
  memoryFolders.set(folder.id, folder);

  // Background IDB write
  set(folder.id, folder, foldersStore).catch(console.error);

  // Cloud sync
  if (isSupabaseConfigured) {
    saveFolderToSupabase({
      id: folder.id,
      name: folder.name,
      parent_id: folder.parentId,
    }).then((ok) => {
      if (ok) {
        folder.syncedToCloud = true;
        set(folder.id, folder, foldersStore).catch(console.warn);
      }
    });
  }

  notifyStoreChanged();
  return folder;
};

export const saveFolder = async (folder: FolderItem): Promise<void> => {
  await initializeStoresIfNeeded();

  const updated: FolderItem = {
    ...folder,
    updatedAt: Date.now(),
  };

  memoryFolders.set(updated.id, updated);
  set(updated.id, updated, foldersStore).catch(console.error);

  if (isSupabaseConfigured) {
    saveFolderToSupabase({
      id: updated.id,
      name: updated.name,
      parent_id: updated.parentId,
    }).then((ok) => {
      if (ok) {
        updated.syncedToCloud = true;
        set(updated.id, updated, foldersStore).catch(console.warn);
      }
    });
  }

  notifyStoreChanged();
};

export const deleteFolder = async (id: string): Promise<boolean> => {
  await initializeStoresIfNeeded();

  try {
    memoryFolders.delete(id);
    del(id, foldersStore).catch(console.error);

    // Delete child folders
    const allFolders = Array.from(memoryFolders.values());
    for (const child of allFolders) {
      if (child.parentId === id) {
        await deleteFolder(child.id);
      }
    }

    // Move child documents to root
    const allDocs = Array.from(memoryMeta.values());
    for (const doc of allDocs) {
      if (doc.folderId === id) {
        await moveDocumentToFolder(doc.id, null);
      }
    }

    if (isSupabaseConfigured) {
      deleteFolderFromSupabase(id).catch(console.warn);
    }

    notifyStoreChanged();
    return true;
  } catch (error) {
    console.error("Failed to delete folder:", error);
    return false;
  }
};

// ---------------------------------------------------------------------------
// DOCUMENTS MANAGEMENT
// ---------------------------------------------------------------------------

export const migrateFromLocalStorageIfNeeded = async (): Promise<ExcalidrawDoc | null> => {
  try {
    const rawElements = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS);
    const rawState = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE);

    if (rawElements) {
      const elements = JSON.parse(rawElements);
      const appState = rawState ? JSON.parse(rawState) : {};

      const defaultDoc: ExcalidrawDoc = {
        id: "default",
        title: appState.name || "My First Drawing",
        elements: Array.isArray(elements) ? elements : [],
        appState: appState || {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await saveDocument(defaultDoc);

      try {
        localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS);
        localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE);
      } catch (e) {
        // ignore
      }

      return defaultDoc;
    }
  } catch (error) {
    console.error("Migration from localStorage failed:", error);
  }
  return null;
};

export const listDocuments = async (): Promise<DocumentMetadata[]> => {
  await initializeStoresIfNeeded();

  try {
    // Merge cloud documents if Supabase user is logged in
    if (isSupabaseConfigured) {
      const user = await getSupabaseUser();
      if (user) {
        const cloudDocs = await fetchDocumentsFromSupabase();
        for (const cloudDoc of cloudDocs) {
          const cloudUpdatedAt = new Date(cloudDoc.updated_at).getTime();
          const existing = memoryMeta.get(cloudDoc.id);

          if (!existing || cloudUpdatedAt >= existing.updatedAt) {
            const meta: DocumentMetadata = {
              id: cloudDoc.id,
              title: cloudDoc.title,
              folderId: cloudDoc.folder_id || null,
              thumbnail: cloudDoc.thumbnail_url || undefined,
              createdAt: new Date(cloudDoc.created_at).getTime(),
              updatedAt: cloudUpdatedAt,
              syncedToCloud: true,
            };
            memoryMeta.set(cloudDoc.id, meta);
            set(cloudDoc.id, meta, metaStore).catch(console.warn);
          }
        }
      }
    }

    const list = Array.from(memoryMeta.values());
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  } catch (error) {
    console.error("Failed to list documents:", error);
    return Array.from(memoryMeta.values());
  }
};

export const loadDocument = async (id: string): Promise<ExcalidrawDoc | null> => {
  await initializeStoresIfNeeded();

  try {
    // 1. In-memory check
    if (memoryDocs.has(id)) {
      return memoryDocs.get(id)!;
    }

    // 2. IndexedDB check
    const localDoc = await get<ExcalidrawDoc>(id, docsStore).catch(() => null);
    if (localDoc) {
      memoryDocs.set(id, localDoc);
      return localDoc;
    }

    // 3. Supabase check
    if (isSupabaseConfigured) {
      const user = await getSupabaseUser();
      if (user) {
        const cloudDocs = await fetchDocumentsFromSupabase();
        const cloudDoc = cloudDocs.find((d) => d.id === id);
        if (cloudDoc) {
          const doc: ExcalidrawDoc = {
            id: cloudDoc.id,
            title: cloudDoc.title,
            folderId: cloudDoc.folder_id || null,
            elements: cloudDoc.elements,
            appState: cloudDoc.app_state,
            thumbnail: cloudDoc.thumbnail_url || undefined,
            createdAt: new Date(cloudDoc.created_at).getTime(),
            updatedAt: new Date(cloudDoc.updated_at).getTime(),
            syncedToCloud: true,
          };
          memoryDocs.set(id, doc);
          saveDocument(doc, false).catch(console.warn);
          return doc;
        }
      }
    }

    // 4. Default document check
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
  await initializeStoresIfNeeded();

  try {
    const existing = memoryDocs.get(doc.id) || (await get<ExcalidrawDoc>(doc.id, docsStore).catch(() => null));

    const resolvedTitle =
      doc.title?.trim() ||
      (doc.appState as any)?.name?.trim() ||
      existing?.title?.trim() ||
      "Untitled Drawing";

    const resolvedFolderId =
      doc.folderId !== undefined
        ? doc.folderId
        : existing?.folderId !== undefined
        ? existing.folderId
        : null;

    const fullDoc: ExcalidrawDoc = {
      id: doc.id,
      title: resolvedTitle,
      folderId: resolvedFolderId,
      elements: doc.elements || existing?.elements || [],
      appState: doc.appState || existing?.appState || {},
      thumbnail: doc.thumbnail !== undefined ? doc.thumbnail : existing?.thumbnail,
      files: doc.files || existing?.files,
      createdAt: existing?.createdAt || doc.createdAt || Date.now(),
      updatedAt: Date.now(),
      syncedToCloud: existing?.syncedToCloud || false,
    };

    const meta: DocumentMetadata = {
      id: fullDoc.id,
      title: fullDoc.title,
      folderId: fullDoc.folderId,
      thumbnail: fullDoc.thumbnail,
      createdAt: fullDoc.createdAt,
      updatedAt: fullDoc.updatedAt,
      syncedToCloud: fullDoc.syncedToCloud,
    };

    // Immediate in-memory update
    memoryDocs.set(fullDoc.id, fullDoc);
    memoryMeta.set(fullDoc.id, meta);

    // Background IDB writes
    set(fullDoc.id, fullDoc, docsStore).catch(console.error);
    set(fullDoc.id, meta, metaStore).catch(console.error);

    // Supabase sync
    if (syncCloud && isSupabaseConfigured) {
      getSupabaseUser().then((user) => {
        if (user) {
          saveDocumentToSupabase({
            id: fullDoc.id,
            title: fullDoc.title,
            folderId: fullDoc.folderId,
            elements: fullDoc.elements,
            appState: fullDoc.appState,
            thumbnail: fullDoc.thumbnail,
            files: fullDoc.files,
          }).then((success) => {
            if (success) {
              fullDoc.syncedToCloud = true;
              meta.syncedToCloud = true;
              set(fullDoc.id, fullDoc, docsStore).catch(console.warn);
              set(fullDoc.id, meta, metaStore).catch(console.warn);
            }
          });
        }
      });
    }

    notifyStoreChanged();
  } catch (error) {
    console.error("Failed to save document:", error);
  }
};

export const createDocument = async (
  title?: string,
  folderId?: string | null,
): Promise<ExcalidrawDoc> => {
  await initializeStoresIfNeeded();

  const id = generateDocId();
  const cleanTitle = title?.trim() || "Untitled Drawing";
  const doc: ExcalidrawDoc = {
    id,
    title: cleanTitle,
    folderId: folderId || null,
    elements: [],
    appState: { name: cleanTitle },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await saveDocument(doc);
  notifyStoreChanged();
  return doc;
};

export const moveDocumentToFolder = async (
  docId: string,
  folderId: string | null,
): Promise<void> => {
  await saveDocument({ id: docId, folderId });
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
    folderId: source.folderId || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    syncedToCloud: false,
  };
  await saveDocument(newDoc);
  notifyStoreChanged();
  return newDoc;
};

export const deleteDocument = async (id: string): Promise<boolean> => {
  await initializeStoresIfNeeded();

  try {
    memoryDocs.delete(id);
    memoryMeta.delete(id);
    del(id, docsStore).catch(console.error);
    del(id, metaStore).catch(console.error);

    if (isSupabaseConfigured) {
      deleteDocumentFromSupabase(id).catch(console.warn);
    }
    notifyStoreChanged();
    return true;
  } catch (error) {
    console.error("Failed to delete document:", error);
    return false;
  }
};
