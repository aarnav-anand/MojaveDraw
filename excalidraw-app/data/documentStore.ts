import { createStore, get, set, del, entries } from "idb-keyval";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { STORAGE_KEYS } from "../app_constants";
import {
  isSupabaseConfigured,
  getSupabaseUser,
  saveDocumentToSupabase,
  fetchDocumentListFromSupabase,
  fetchDocumentFromSupabase,
  deleteDocumentFromSupabase,
  fetchFoldersFromSupabase,
  saveFolderToSupabase,
  deleteFolderFromSupabase,
  subscribeToSupabaseDocumentChanges,
  subscribeToSupabaseFolderChanges,
  onSupabaseAuthStateChange,
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
export type StoreChangeSource = "local" | "remote";
type StoreListener = (source?: StoreChangeSource) => void;
const listeners = new Set<StoreListener>();

export const subscribeToStoreChanges = (listener: StoreListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const notifyStoreChanged = (source: StoreChangeSource = "local") => {
  listeners.forEach((cb) => {
    try {
      cb(source);
    } catch (e) {
      console.error("Store listener error:", e);
    }
  });
};

const clearLocalCaches = () => {
  memoryDocs.clear();
  memoryMeta.clear();
  memoryFolders.clear();
};

const cacheCloudFolder = (cf: {
  id: string;
  name: string;
  parent_id?: string | null;
  created_at: string;
  updated_at: string;
}): FolderItem => {
  const item: FolderItem = {
    id: cf.id,
    name: cf.name,
    parentId: cf.parent_id || null,
    createdAt: new Date(cf.created_at).getTime(),
    updatedAt: new Date(cf.updated_at).getTime(),
    syncedToCloud: true,
  };
  memoryFolders.set(item.id, item);
  set(item.id, item, foldersStore).catch(console.warn);
  return item;
};

const cacheCloudDocument = (cloudDoc: {
  id: string;
  title: string;
  folder_id?: string | null;
  elements?: readonly ExcalidrawElement[];
  app_state?: Partial<AppState>;
  thumbnail_url?: string | null;
  files?: BinaryFiles;
  created_at: string;
  updated_at: string;
}): ExcalidrawDoc => {
  const docFiles = cloudDoc.files || (cloudDoc.app_state as any)?.files;
  const doc: ExcalidrawDoc = {
    id: cloudDoc.id,
    title: cloudDoc.title,
    folderId: cloudDoc.folder_id || null,
    elements: cloudDoc.elements || [],
    appState: cloudDoc.app_state || {},
    thumbnail: cloudDoc.thumbnail_url || undefined,
    files: docFiles,
    createdAt: new Date(cloudDoc.created_at).getTime(),
    updatedAt: new Date(cloudDoc.updated_at).getTime(),
    syncedToCloud: true,
  };
  memoryDocs.set(doc.id, doc);
  memoryMeta.set(doc.id, {
    id: doc.id,
    title: doc.title,
    folderId: doc.folderId,
    thumbnail: doc.thumbnail,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    syncedToCloud: true,
  });
  set(doc.id, doc, docsStore).catch(console.warn);
  return doc;
};

// Real-time synchronization across devices via Supabase
if (typeof window !== "undefined" && isSupabaseConfigured) {
  subscribeToSupabaseDocumentChanges(async (payload) => {
    try {
      if (payload.eventType === "DELETE" && payload.old?.id) {
        memoryDocs.delete(payload.old.id);
        memoryMeta.delete(payload.old.id);
        del(payload.old.id, docsStore).catch(console.warn);
        notifyStoreChanged("remote");
        return;
      }
      if (payload.new?.id) {
        const cloudDoc = await fetchDocumentFromSupabase(payload.new.id);
        if (cloudDoc) {
          cacheCloudDocument(cloudDoc);
          notifyStoreChanged("remote");
        }
      }
    } catch (err) {
      console.error("Realtime document sync error:", err);
    }
  });

  subscribeToSupabaseFolderChanges(async (payload) => {
    try {
      if (payload.eventType === "DELETE" && payload.old?.id) {
        memoryFolders.delete(payload.old.id);
        del(payload.old.id, foldersStore).catch(console.warn);
        notifyStoreChanged("remote");
        return;
      }
      if (payload.new?.id) {
        cacheCloudFolder(payload.new);
        notifyStoreChanged("remote");
      }
    } catch (err) {
      console.error("Realtime folder sync error:", err);
    }
  });

  onSupabaseAuthStateChange((user) => {
    if (!user) {
      clearLocalCaches();
      notifyStoreChanged("remote");
    }
  });
}

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
    // When Supabase is configured, never hydrate the UI from IndexedDB /
    // localStorage. Cloud records are loaded on demand via list/load APIs.
    if (isSupabaseConfigured) {
      return;
    }

    const metaEntries = await entries(metaStore).catch(() => []);
    for (const [, value] of metaEntries) {
      if (value && typeof value === "object") {
        const item = value as DocumentMetadata;
        memoryMeta.set(item.id, item);
      }
    }

    const folderEntries = await entries(foldersStore).catch(() => []);
    for (const [, value] of folderEntries) {
      if (value && typeof value === "object") {
        const item = value as FolderItem;
        memoryFolders.set(item.id, item);
      }
    }

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
    if (isSupabaseConfigured) {
      const user = await getSupabaseUser();
      if (!user) {
        clearLocalCaches();
        return [];
      }

      const cloudFolders = await fetchFoldersFromSupabase();
      const cloudFolderIds = new Set<string>();
      const list: FolderItem[] = [];

      for (const cf of cloudFolders) {
        cloudFolderIds.add(cf.id);
        list.push(cacheCloudFolder(cf));
      }

      for (const [id] of memoryFolders.entries()) {
        if (!cloudFolderIds.has(id)) {
          memoryFolders.delete(id);
        }
      }

      list.sort((a, b) => a.name.localeCompare(b.name));
      return list;
    }

    return [];
  } catch (error) {
    console.error("Failed to list folders:", error);
    return [];
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

  if (isSupabaseConfigured) {
    const user = await getSupabaseUser();
    if (!user) {
      return folder;
    }
    const ok = await saveFolderToSupabase({
      id: folder.id,
      name: folder.name,
      parent_id: folder.parentId,
    });
    if (!ok) {
      return folder;
    }
    folder.syncedToCloud = true;
  }

  memoryFolders.set(folder.id, folder);
  set(folder.id, folder, foldersStore).catch(console.error);
  notifyStoreChanged("local");
  return folder;
};

export const saveFolder = async (folder: FolderItem): Promise<void> => {
  await initializeStoresIfNeeded();

  const updated: FolderItem = {
    ...folder,
    updatedAt: Date.now(),
  };

  if (isSupabaseConfigured) {
    const user = await getSupabaseUser();
    if (!user) {
      return;
    }
    const ok = await saveFolderToSupabase({
      id: updated.id,
      name: updated.name,
      parent_id: updated.parentId,
    });
    if (!ok) {
      return;
    }
    updated.syncedToCloud = true;
  }

  memoryFolders.set(updated.id, updated);
  set(updated.id, updated, foldersStore).catch(console.error);
  notifyStoreChanged("local");
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
      await deleteFolderFromSupabase(id);
    }

    notifyStoreChanged("local");
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
  if (isSupabaseConfigured) {
    return null;
  }
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
    if (isSupabaseConfigured) {
      const user = await getSupabaseUser();
      if (!user) {
        clearLocalCaches();
        return [];
      }

      const cloudDocs = await fetchDocumentListFromSupabase();
      const cloudDocIds = new Set<string>();
      const list: DocumentMetadata[] = [];

      for (const cloudDoc of cloudDocs) {
        const meta: DocumentMetadata = {
          id: cloudDoc.id,
          title: cloudDoc.title,
          folderId: cloudDoc.folder_id || null,
          thumbnail: cloudDoc.thumbnail_url || undefined,
          createdAt: new Date(cloudDoc.created_at).getTime(),
          updatedAt: new Date(cloudDoc.updated_at).getTime(),
          syncedToCloud: true,
        };
        cloudDocIds.add(cloudDoc.id);
        memoryMeta.set(cloudDoc.id, meta);
        set(cloudDoc.id, meta, metaStore).catch(console.warn);
        list.push(meta);
      }

      for (const [id] of memoryMeta.entries()) {
        if (!cloudDocIds.has(id)) {
          memoryMeta.delete(id);
          memoryDocs.delete(id);
        }
      }

      list.sort((a, b) => b.updatedAt - a.updatedAt);
      return list;
    }

    return [];
  } catch (error) {
    console.error("Failed to list documents:", error);
    return [];
  }
};

export const loadDocument = async (id: string): Promise<ExcalidrawDoc | null> => {
  await initializeStoresIfNeeded();

  try {
    if (isSupabaseConfigured) {
      const user = await getSupabaseUser();
      if (!user) {
        return null;
      }

      let cloudDoc = id !== "default" ? await fetchDocumentFromSupabase(id) : null;
      if (!cloudDoc) {
        const list = await fetchDocumentListFromSupabase();
        if (list.length > 0) {
          const match = (id !== "default" ? list.find((d) => d.id === id) : null) || list[0];
          cloudDoc = await fetchDocumentFromSupabase(match.id);
        } else {
          return await createDocument("Untitled Drawing");
        }
      }

      if (cloudDoc) {
        return cacheCloudDocument(cloudDoc);
      }

      const cached = memoryDocs.get(id);
      return cached?.syncedToCloud ? cached : null;
    }

    if (memoryDocs.has(id)) {
      return memoryDocs.get(id)!;
    }

    const localDoc = await get<ExcalidrawDoc>(id, docsStore).catch(() => null);
    if (localDoc) {
      memoryDocs.set(id, localDoc);
      return localDoc;
    }

    if (id === "default") {
      return migrateFromLocalStorageIfNeeded();
    }

    return null;
  } catch (error) {
    console.error("Failed to load document:", error);
    return null;
  }
};

const cloudSyncDebounceTimers = new Map<string, number>();
const cloudSyncInFlight = new Map<string, boolean>();
const cloudSyncPendingDirty = new Map<string, boolean>();
const CLOUD_SYNC_DEBOUNCE_MS = 1200;

export const flushCloudSync = async (docId: string): Promise<boolean> => {
  if (typeof window !== "undefined") {
    const timer = cloudSyncDebounceTimers.get(docId);
    if (timer) {
      window.clearTimeout(timer);
      cloudSyncDebounceTimers.delete(docId);
    }
  }
  return executeCloudSync(docId);
};

const scheduleBackgroundCloudSync = (docId: string) => {
  if (typeof window === "undefined") {
    return;
  }
  const existingTimer = cloudSyncDebounceTimers.get(docId);
  if (existingTimer) {
    window.clearTimeout(existingTimer);
  }
  cloudSyncDebounceTimers.set(
    docId,
    window.setTimeout(() => {
      cloudSyncDebounceTimers.delete(docId);
      executeCloudSync(docId);
    }, CLOUD_SYNC_DEBOUNCE_MS),
  );
};

const executeCloudSync = async (docId: string): Promise<boolean> => {
  if (cloudSyncInFlight.get(docId)) {
    cloudSyncPendingDirty.set(docId, true);
    return false;
  }

  const latestDoc = memoryDocs.get(docId);
  if (!latestDoc) {
    return false;
  }

  cloudSyncInFlight.set(docId, true);
  try {
    const user = await getSupabaseUser();
    if (!user) {
      return false;
    }

    const success = await saveDocumentToSupabase({
      id: latestDoc.id,
      title: latestDoc.title,
      folderId: latestDoc.folderId,
      elements: latestDoc.elements,
      appState: latestDoc.appState,
      thumbnail: latestDoc.thumbnail,
      files: latestDoc.files,
    });

    if (success) {
      latestDoc.syncedToCloud = true;
      const meta = memoryMeta.get(docId);
      if (meta) {
        meta.syncedToCloud = true;
        set(docId, meta, metaStore).catch(console.warn);
      }
      set(docId, latestDoc, docsStore).catch(console.warn);
    }
    return success;
  } catch (err) {
    console.error("Cloud sync error for doc", docId, err);
    return false;
  } finally {
    cloudSyncInFlight.delete(docId);
    if (cloudSyncPendingDirty.get(docId)) {
      cloudSyncPendingDirty.delete(docId);
      scheduleBackgroundCloudSync(docId);
    }
  }
};

export const saveDocument = async (
  doc: Partial<ExcalidrawDoc> & { id: string },
  syncCloud: boolean = true,
): Promise<void> => {
  await initializeStoresIfNeeded();

  try {
    let docId = doc.id;
    if (isSupabaseConfigured && docId === "default") {
      const activeUrlId = getActiveDocIdFromUrl();
      if (activeUrlId && activeUrlId !== "default") {
        docId = activeUrlId;
      } else {
        docId = generateDocId();
        setActiveDocIdToUrl(docId);
      }
    }

    const existing =
      memoryDocs.get(docId) ||
      (isSupabaseConfigured
        ? null
        : await get<ExcalidrawDoc>(docId, docsStore).catch(() => null));

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
      id: docId,
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

    memoryDocs.set(fullDoc.id, fullDoc);
    memoryMeta.set(fullDoc.id, meta);
    set(fullDoc.id, fullDoc, docsStore).catch(console.error);
    set(fullDoc.id, meta, metaStore).catch(console.error);
    notifyStoreChanged("local");

    if (syncCloud && isSupabaseConfigured) {
      scheduleBackgroundCloudSync(fullDoc.id);
    }
  } catch (error) {
    console.error("Failed to save document:", error);
  }
};

export const createDocument = async (
  title?: string,
  folderId?: string | null,
  initialData?: {
    elements?: readonly ExcalidrawElement[];
    appState?: Partial<AppState>;
    files?: BinaryFiles;
  },
): Promise<ExcalidrawDoc> => {
  await initializeStoresIfNeeded();

  const id = generateDocId();
  const cleanTitle = title?.trim() || "Untitled Drawing";
  const doc: ExcalidrawDoc = {
    id,
    title: cleanTitle,
    folderId: folderId || null,
    elements: initialData?.elements || [],
    appState: { ...initialData?.appState, name: cleanTitle, isLoading: false },
    files: initialData?.files,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    syncedToCloud: false,
  };

  await saveDocument(doc, false);
  if (isSupabaseConfigured) {
    await executeCloudSync(doc.id);
  }
  return doc;
};

export const deletePdfFromDocument = async (docId: string): Promise<boolean> => {
  const doc = await loadDocument(docId);
  if (!doc) {
    return false;
  }
  const remainingElements = doc.elements.filter(
    (el) =>
      !(
        el.type === "image" &&
        (el.fileId?.startsWith("pdf_") || (el.customData as any)?.isPdf)
      ),
  );
  if (remainingElements.length === doc.elements.length) {
    return false;
  }
  await saveDocument({
    id: docId,
    elements: remainingElements,
  });
  return true;
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
      await deleteDocumentFromSupabase(id);
    }
    notifyStoreChanged("local");
    return true;
  } catch (error) {
    console.error("Failed to delete document:", error);
    return false;
  }
};
