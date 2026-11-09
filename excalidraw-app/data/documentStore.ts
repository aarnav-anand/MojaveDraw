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

const docsStore = createStore("excalidraw-documents-db", "documents");
const metaStore = createStore("excalidraw-documents-db", "documents-meta");
const foldersStore = createStore("excalidraw-documents-db", "folders");

const ACTIVE_DOC_STORAGE_KEY = "excalidraw_active_doc_id";

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
// FOLDERS MANAGEMENT
// ---------------------------------------------------------------------------

export const listFolders = async (): Promise<FolderItem[]> => {
  try {
    const localFolders: FolderItem[] = [];
    const folderEntries = await entries(foldersStore);
    for (const [, value] of folderEntries) {
      if (value && typeof value === "object") {
        localFolders.push(value as FolderItem);
      }
    }

    if (isSupabaseConfigured) {
      const user = await getSupabaseUser();
      if (user) {
        const cloudFolders = await fetchFoldersFromSupabase();
        const mergedMap = new Map<string, FolderItem>();

        for (const f of localFolders) {
          mergedMap.set(f.id, f);
        }

        for (const cf of cloudFolders) {
          const cfUpdatedAt = new Date(cf.updated_at).getTime();
          const existing = mergedMap.get(cf.id);

          if (!existing || cfUpdatedAt >= existing.updatedAt) {
            const item: FolderItem = {
              id: cf.id,
              name: cf.name,
              parentId: cf.parent_id || null,
              createdAt: new Date(cf.created_at).getTime(),
              updatedAt: cfUpdatedAt,
              syncedToCloud: true,
            };
            mergedMap.set(cf.id, item);
            await set(cf.id, item, foldersStore);
          }
        }

        const mergedList = Array.from(mergedMap.values());
        mergedList.sort((a, b) => a.name.localeCompare(b.name));
        return mergedList;
      }
    }

    localFolders.sort((a, b) => a.name.localeCompare(b.name));
    return localFolders;
  } catch (error) {
    console.error("Failed to list folders:", error);
    return [];
  }
};

export const createFolder = async (
  name: string,
  parentId?: string | null,
): Promise<FolderItem> => {
  const id = generateFolderId();
  const folder: FolderItem = {
    id,
    name: name.trim() || "New Folder",
    parentId: parentId || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await set(folder.id, folder, foldersStore);

  if (isSupabaseConfigured) {
    saveFolderToSupabase({
      id: folder.id,
      name: folder.name,
      parent_id: folder.parentId,
    }).then((ok) => {
      if (ok) {
        folder.syncedToCloud = true;
        set(folder.id, folder, foldersStore);
      }
    });
  }

  notifyStoreChanged();
  return folder;
};

export const saveFolder = async (folder: FolderItem): Promise<void> => {
  try {
    const updated: FolderItem = {
      ...folder,
      updatedAt: Date.now(),
    };
    await set(updated.id, updated, foldersStore);

    if (isSupabaseConfigured) {
      saveFolderToSupabase({
        id: updated.id,
        name: updated.name,
        parent_id: updated.parentId,
      }).then((ok) => {
        if (ok) {
          updated.syncedToCloud = true;
          set(updated.id, updated, foldersStore);
        }
      });
    }
    notifyStoreChanged();
  } catch (error) {
    console.error("Failed to save folder:", error);
  }
};

export const deleteFolder = async (id: string): Promise<boolean> => {
  try {
    // 1. Delete folder from local IDB
    await del(id, foldersStore);

    // 2. Unassign or delete sub-items
    const allFolders = await listFolders();
    const childFolders = allFolders.filter((f) => f.parentId === id);
    for (const child of childFolders) {
      await deleteFolder(child.id);
    }

    const allDocs = await listDocuments();
    const childDocs = allDocs.filter((d) => d.folderId === id);
    for (const doc of childDocs) {
      await moveDocumentToFolder(doc.id, null);
    }

    // 3. Supabase delete
    if (isSupabaseConfigured) {
      deleteFolderFromSupabase(id).catch(console.error);
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
    // 1. Fetch from local IndexedDB metaStore
    const localMetas: DocumentMetadata[] = [];
    const metaEntries = await entries(metaStore);
    for (const [, value] of metaEntries) {
      if (value && typeof value === "object") {
        localMetas.push(value as DocumentMetadata);
      }
    }

    // Ensure "default" document is indexed if it exists in docsStore
    const hasDefault = localMetas.some((m) => m.id === "default");
    if (!hasDefault) {
      const defaultDoc = await get<ExcalidrawDoc>("default", docsStore);
      if (defaultDoc) {
        const meta: DocumentMetadata = {
          id: defaultDoc.id,
          title: defaultDoc.title || "My First Drawing",
          folderId: defaultDoc.folderId || null,
          thumbnail: defaultDoc.thumbnail,
          createdAt: defaultDoc.createdAt,
          updatedAt: defaultDoc.updatedAt,
          syncedToCloud: defaultDoc.syncedToCloud,
        };
        await set("default", meta, metaStore);
        localMetas.push(meta);
      }
    }

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
            mergedMap.set(cloudDoc.id, meta);
            await set(cloudDoc.id, meta, metaStore);
          }
        }

        const mergedList = Array.from(mergedMap.values());
        mergedList.sort((a, b) => b.updatedAt - a.updatedAt);
        return mergedList;
      }
    }

    localMetas.sort((a, b) => b.updatedAt - a.updatedAt);
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

    // Save full document to IndexedDB
    await set(fullDoc.id, fullDoc, docsStore);

    // Save lightweight metadata to index store
    const meta: DocumentMetadata = {
      id: fullDoc.id,
      title: fullDoc.title,
      folderId: fullDoc.folderId,
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
            folderId: fullDoc.folderId,
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

    notifyStoreChanged();
  } catch (error) {
    console.error("Failed to save document:", error);
  }
};

export const createDocument = async (
  title?: string,
  folderId?: string | null,
): Promise<ExcalidrawDoc> => {
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
  try {
    await del(id, docsStore);
    await del(id, metaStore);

    if (isSupabaseConfigured) {
      deleteDocumentFromSupabase(id).catch(console.error);
    }
    notifyStoreChanged();
    return true;
  } catch (error) {
    console.error("Failed to delete document:", error);
    return false;
  }
};
