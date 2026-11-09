/**
 * This file deals with saving data state (appState, elements, images, ...)
 * locally to the browser.
 *
 * Notes:
 *
 * - DataState refers to full state of the app: appState, elements, images,
 *   though some state is saved separately (collab username, library) for one
 *   reason or another. We also save different data to different storage
 *   (localStorage, indexedDB).
 */

import { clearAppStateForLocalStorage } from "@excalidraw/excalidraw/appState";
import {
  CANVAS_SEARCH_TAB,
  DEFAULT_SIDEBAR,
  debounce,
} from "@excalidraw/common";
import {
  createStore,
  entries,
  del,
  getMany,
  set,
  setMany,
  get,
} from "idb-keyval";

import { getNonDeletedElements } from "@excalidraw/element";

import type { LibraryPersistedData } from "@excalidraw/excalidraw/data/library";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";
import type { MaybePromise } from "@excalidraw/common/utility-types";

import { appJotaiStore, atom } from "../app-jotai";
import { SAVE_TO_LOCAL_STORAGE_TIMEOUT, STORAGE_KEYS } from "../app_constants";

import { FileManager } from "./FileManager";
import { FileStatusStore } from "./fileStatusStore";
import { Locker } from "./Locker";
import { updateBrowserStateVersion } from "./tabSync";
import { saveDocument, getActiveDocumentId } from "./documentStore";

const filesStore = createStore("files-db", "files-store");

export const localStorageQuotaExceededAtom = atom(false);

class LocalFileManager extends FileManager {
  clearObsoleteFiles = async (opts: { currentFileIds: FileId[] }) => {
    await entries(filesStore).then((entries) => {
      for (const [id, imageData] of entries as [FileId, BinaryFileData][]) {
        // if image is unused (not on canvas) & is older than 1 day, delete it
        // from storage. We check `lastRetrieved` we care about the last time
        // the image was used (loaded on canvas), not when it was initially
        // created.
        if (
          (!imageData.lastRetrieved ||
            Date.now() - imageData.lastRetrieved > 24 * 3600 * 1000) &&
          !opts.currentFileIds.includes(id as FileId)
        ) {
          del(id, filesStore);
        }
      }
    });
  };
}

const saveDataStateToLocalStorage = (
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files?: BinaryFiles,
) => {
  try {
    const _appState = clearAppStateForLocalStorage(appState);

    if (
      _appState.openSidebar?.name === DEFAULT_SIDEBAR.name &&
      _appState.openSidebar.tab === CANVAS_SEARCH_TAB
    ) {
      _appState.openSidebar = null;
    }

    const nonDeletedElements = getNonDeletedElements(elements);
    const activeDocId = getActiveDocumentId();

    // 1. High-capacity persistence via IndexedDB and Supabase cloud sync (including binary files/PDFs)
    saveDocument({
      id: activeDocId,
      title: _appState.name || undefined,
      elements: nonDeletedElements,
      appState: _appState,
      files,
    });

    // 2. Best-effort write to localStorage for compatibility if it fits
    try {
      localStorage.setItem(
        STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
        JSON.stringify(nonDeletedElements),
      );
      localStorage.setItem(
        STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
        JSON.stringify(_appState),
      );
    } catch {
      // If localStorage is full, ignore it because data is safely stored in IndexedDB!
    }

    updateBrowserStateVersion(STORAGE_KEYS.VERSION_DATA_STATE);
    if (appJotaiStore.get(localStorageQuotaExceededAtom)) {
      appJotaiStore.set(localStorageQuotaExceededAtom, false);
    }
  } catch (error: any) {
    console.error("Error saving data state:", error);
  }
};

const isQuotaExceededError = (error: any) => {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      error.name === "QUOTA_EXCEEDED_ERR" ||
      error.code === 22 ||
      error.code === 1014)
  );
};

type SavingLockTypes = "collaboration";

export class LocalData {
  private static _save = debounce(
    async (
      elements: readonly ExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
      onFilesSaved: () => void,
    ) => {
      saveDataStateToLocalStorage(elements, appState, files);

      await this.fileStorage.saveFiles({
        elements,
        files,
      });
      onFilesSaved();
    },
    SAVE_TO_LOCAL_STORAGE_TIMEOUT,
  );

  /** Saves DataState, including files. Bails if saving is paused */
  static save = (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
    onFilesSaved: () => void,
  ) => {
    // we need to make the `isSavePaused` check synchronously (undebounced)
    if (!this.isSavePaused()) {
      this._save(elements, appState, files, onFilesSaved);
    }
  };

  static flushSave = () => {
    this._save.flush();
  };

  private static locker = new Locker<SavingLockTypes>();

  static pauseSave = (lockType: SavingLockTypes) => {
    this.locker.lock(lockType);
  };

  static resumeSave = (lockType: SavingLockTypes) => {
    this.locker.unlock(lockType);
  };

  static isSavePaused = () => {
    return document.hidden || this.locker.isLocked();
  };

  // ---------------------------------------------------------------------------

  static fileStorage = new LocalFileManager({
    onFileStatusChange: FileStatusStore.updateStatuses.bind(FileStatusStore),
    getFiles(ids) {
      return getMany(ids, filesStore).then(
        async (filesData: (BinaryFileData | undefined)[]) => {
          const loadedFiles: BinaryFileData[] = [];
          const erroredFiles = new Map<FileId, true>();

          const filesToSave: [FileId, BinaryFileData][] = [];

          filesData.forEach((data, index) => {
            const id = ids[index];
            if (data) {
              const _data: BinaryFileData = {
                ...data,
                lastRetrieved: Date.now(),
              };
              filesToSave.push([id, _data]);
              loadedFiles.push(_data);
            } else {
              erroredFiles.set(id, true);
            }
          });

          try {
            // save loaded files back to storage with updated `lastRetrieved`
            setMany(filesToSave, filesStore);
          } catch (error) {
            console.warn(error);
          }

          return { loadedFiles, erroredFiles };
        },
      );
    },
    async saveFiles({ addedFiles }) {
      const savedFiles = new Map<FileId, BinaryFileData>();
      const erroredFiles = new Map<FileId, BinaryFileData>();

      // before we use `storage` event synchronization, let's update the flag
      // optimistically. Hopefully nothing fails, and an IDB read executed
      // before an IDB write finishes will read the latest value.
      updateBrowserStateVersion(STORAGE_KEYS.VERSION_FILES);

      await Promise.all(
        [...addedFiles].map(async ([id, fileData]) => {
          try {
            await set(id, fileData, filesStore);
            savedFiles.set(id, fileData);
          } catch (error: any) {
            console.error(error);
            erroredFiles.set(id, fileData);
          }
        }),
      );

      return { savedFiles, erroredFiles };
    },
  });
}
export class LibraryIndexedDBAdapter {
  /** IndexedDB database and store name */
  private static idb_name = STORAGE_KEYS.IDB_LIBRARY;
  /** library data store key */
  private static key = "libraryData";

  private static store = createStore(
    `${LibraryIndexedDBAdapter.idb_name}-db`,
    `${LibraryIndexedDBAdapter.idb_name}-store`,
  );

  static async load() {
    const IDBData = await get<LibraryPersistedData>(
      LibraryIndexedDBAdapter.key,
      LibraryIndexedDBAdapter.store,
    );

    return IDBData || null;
  }

  static save(data: LibraryPersistedData): MaybePromise<void> {
    return set(
      LibraryIndexedDBAdapter.key,
      data,
      LibraryIndexedDBAdapter.store,
    );
  }
}

/** LS Adapter used only for migrating LS library data
 * to indexedDB */
export class LibraryLocalStorageMigrationAdapter {
  static load() {
    const LSData = localStorage.getItem(
      STORAGE_KEYS.__LEGACY_LOCAL_STORAGE_LIBRARY,
    );
    if (LSData != null) {
      const libraryItems: ImportedDataState["libraryItems"] =
        JSON.parse(LSData);
      if (libraryItems) {
        return { libraryItems };
      }
    }
    return null;
  }
  static clear() {
    localStorage.removeItem(STORAGE_KEYS.__LEGACY_LOCAL_STORAGE_LIBRARY);
  }
}
