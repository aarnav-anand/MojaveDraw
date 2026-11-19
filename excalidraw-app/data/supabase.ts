import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";

export interface SupabaseFolderRecord {
  id: string;
  user_id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupabaseDocumentRecord {
  id: string;
  user_id: string;
  title: string;
  folder_id?: string | null;
  elements: readonly ExcalidrawElement[];
  app_state: Partial<AppState>;
  thumbnail_url?: string | null;
  created_at: string;
  updated_at: string;
  files?: BinaryFiles;
}

export interface SupabaseDocumentListItem {
  id: string;
  user_id: string;
  title: string;
  folder_id?: string | null;
  thumbnail_url?: string | null;
  created_at: string;
  updated_at: string;
}

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : null;

export const getSupabaseUser = async (): Promise<User | null> => {
  if (!supabase) {
    return null;
  }
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return null;
  }
  return data.user;
};

export const onSupabaseAuthStateChange = (callback: (user: User | null) => void) => {
  if (!supabase) {
    return () => {};
  }
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });
  return () => {
    subscription.unsubscribe();
  };
};

const isRemoteUrl = (value?: string) =>
  Boolean(value && (value.startsWith("http://") || value.startsWith("https://")));

const blobToDataURL = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

export const uploadFileToSupabaseStorage = async (
  filePathWithoutUser: string,
  fileData: BinaryFileData,
): Promise<string | null> => {
  if (!supabase) {
    return null;
  }
  try {
    const user = await getSupabaseUser();
    if (!user) {
      return null;
    }

    const response = await fetch(fileData.dataURL);
    const blob = await response.blob();
    const filePath = `${user.id}/${filePathWithoutUser}`;

    const { error } = await supabase.storage.from("canvas-files").upload(filePath, blob, {
      contentType: fileData.mimeType,
      upsert: true,
    });

    if (error) {
      console.warn("Error uploading file to Supabase Storage:", error);
      return null;
    }

    const { data } = supabase.storage.from("canvas-files").getPublicUrl(filePath);
    return data?.publicUrl ?? null;
  } catch (err) {
    console.error("Failed to upload file to Supabase:", err);
    return null;
  }
};

const persistFilesToStorage = async (
  docId: string,
  files?: BinaryFiles,
): Promise<BinaryFiles | undefined> => {
  if (!files || Object.keys(files).length === 0) {
    return files;
  }

  const persisted: BinaryFiles = {};
  await Promise.all(
    Object.entries(files).map(async ([fileId, fileData]) => {
      if (!fileData) {
        return;
      }
      if (isRemoteUrl(fileData.dataURL)) {
        persisted[fileId] = fileData;
        return;
      }
      const url = await uploadFileToSupabaseStorage(`${docId}/${fileId}`, fileData);
      persisted[fileId] = url
        ? { ...fileData, dataURL: url as BinaryFileData["dataURL"] }
        : fileData;
    }),
  );
  return persisted;
};

export const hydrateFilesFromStorage = async (
  files?: BinaryFiles,
): Promise<BinaryFiles | undefined> => {
  if (!files || Object.keys(files).length === 0) {
    return files;
  }

  const hydrated: BinaryFiles = {};
  await Promise.all(
    Object.entries(files).map(async ([fileId, fileData]) => {
      if (!fileData) {
        return;
      }
      if (!isRemoteUrl(fileData.dataURL)) {
        hydrated[fileId] = fileData;
        return;
      }
      try {
        const response = await fetch(fileData.dataURL);
        if (!response.ok) {
          hydrated[fileId] = fileData;
          return;
        }
        const blob = await response.blob();
        const dataURL = (await blobToDataURL(blob)) as BinaryFileData["dataURL"];
        hydrated[fileId] = { ...fileData, dataURL };
      } catch {
        hydrated[fileId] = fileData;
      }
    }),
  );
  return hydrated;
};

const mapDocumentRow = (row: any): SupabaseDocumentRecord => {
  const files = row.files || row.app_state?.files || undefined;
  let cleanAppState = row.app_state || {};
  if (cleanAppState.files) {
    const { files: _ignored, ...rest } = cleanAppState;
    cleanAppState = rest;
  }
  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    folder_id: row.folder_id || null,
    elements: row.elements || [],
    app_state: cleanAppState,
    thumbnail_url: row.thumbnail_url || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    files,
  };
};

export const saveDocumentToSupabase = async (doc: {
  id: string;
  title: string;
  folderId?: string | null;
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  thumbnail?: string;
  files?: BinaryFiles;
}): Promise<boolean> => {
  if (!supabase) {
    return false;
  }
  try {
    const user = await getSupabaseUser();
    if (!user) {
      return false;
    }

    const hasFiles = Boolean(doc.files && Object.keys(doc.files).length > 0);
    const { files: _ignored, ...appStateWithoutFiles } = (doc.appState || {}) as any;

    const payload: any = {
      id: doc.id,
      user_id: user.id,
      title: doc.title || "Untitled Drawing",
      elements: doc.elements,
      app_state: {
        ...appStateWithoutFiles,
        ...(hasFiles ? { files: doc.files } : {}),
      },
      thumbnail_url: doc.thumbnail || null,
      updated_at: new Date().toISOString(),
    };

    if (doc.folderId !== undefined) {
      payload.folder_id = doc.folderId;
    }

    if (hasFiles) {
      payload.files = doc.files;
    }

    let { error } = await supabase.from("documents").upsert(payload, { onConflict: "id" });

    if (error && error.message?.includes("files")) {
      delete payload.files;
      const retry = await supabase.from("documents").upsert(payload, { onConflict: "id" });
      error = retry.error;
    }

    if (
      error &&
      (error.message?.includes("folder_id") ||
        error.message?.includes("folders") ||
        error.message?.includes("fkey") ||
        error.message?.includes("foreign key") ||
        error.message?.includes("violates"))
    ) {
      delete payload.folder_id;
      const retry = await supabase.from("documents").upsert(payload, { onConflict: "id" });
      error = retry.error;
    }

    if (error) {
      console.error("Error saving document to Supabase:", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Exception saving document to Supabase:", err);
    return false;
  }
};

export const fetchDocumentListFromSupabase = async (): Promise<SupabaseDocumentListItem[]> => {
  if (!supabase) {
    return [];
  }
  try {
    const user = await getSupabaseUser();
    if (!user) {
      return [];
    }

    const { data, error } = await supabase
      .from("documents")
      .select("id, user_id, title, folder_id, thumbnail_url, created_at, updated_at")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false });

    if (error || !data) {
      const fallback = await supabase
        .from("documents")
        .select("id, user_id, title, thumbnail_url, created_at, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false });
      if (fallback.error || !fallback.data) {
        console.error("Error fetching document list from Supabase:", error || fallback.error);
        return [];
      }
      return (fallback.data as any[]).map((row) => ({
        ...row,
        folder_id: null,
      }));
    }

    return data as SupabaseDocumentListItem[];
  } catch (err) {
    console.error("Exception fetching document list from Supabase:", err);
    return [];
  }
};

export const fetchDocumentsFromSupabase = async (): Promise<SupabaseDocumentRecord[]> => {
  if (!supabase) {
    return [];
  }
  try {
    const user = await getSupabaseUser();
    if (!user) {
      return [];
    }

    let { data, error } = await supabase
      .from("documents")
      .select("*")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false });

    if (error) {
      const fallback = await supabase
        .from("documents")
        .select("id, user_id, title, elements, app_state, thumbnail_url, created_at, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false });
      data = fallback.data as any;
      error = fallback.error;
    }

    if (error || !data) {
      console.error("Error fetching documents from Supabase:", error);
      return [];
    }

    const records = await Promise.all(
      (data as any[]).map(async (row) => {
        const mapped = mapDocumentRow(row);
        mapped.files = await hydrateFilesFromStorage(mapped.files);
        return mapped;
      }),
    );

    return records;
  } catch (err) {
    console.error("Exception fetching documents from Supabase:", err);
    return [];
  }
};

export const fetchFoldersFromSupabase = async (): Promise<SupabaseFolderRecord[]> => {
  if (!supabase) {
    return [];
  }
  try {
    const user = await getSupabaseUser();
    if (!user) {
      return [];
    }

    const { data, error } = await supabase
      .from("folders")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });

    if (error) {
      console.warn("Could not fetch folders from Supabase (may need schema update):", error.message);
      return [];
    }
    return (data || []) as SupabaseFolderRecord[];
  } catch (err) {
    console.warn("Exception fetching folders from Supabase:", err);
    return [];
  }
};

export const saveFolderToSupabase = async (folder: {
  id: string;
  name: string;
  parent_id?: string | null;
}): Promise<boolean> => {
  if (!supabase) {
    return false;
  }
  try {
    const user = await getSupabaseUser();
    if (!user) {
      return false;
    }

    const { error } = await supabase.from("folders").upsert(
      {
        id: folder.id,
        user_id: user.id,
        name: folder.name,
        parent_id: folder.parent_id || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );

    if (error) {
      console.warn("Error saving folder to Supabase:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("Exception saving folder to Supabase:", err);
    return false;
  }
};

export const deleteFolderFromSupabase = async (id: string): Promise<boolean> => {
  if (!supabase) {
    return false;
  }
  try {
    const { error } = await supabase.from("folders").delete().eq("id", id);
    if (error) {
      console.warn("Error deleting folder from Supabase:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("Exception deleting folder from Supabase:", err);
    return false;
  }
};

export const fetchDocumentFromSupabase = async (
  id: string,
): Promise<SupabaseDocumentRecord | null> => {
  if (!supabase) {
    return null;
  }
  try {
    const { data, error } = await supabase.from("documents").select("*").eq("id", id).single();

    if (error || !data) {
      return null;
    }

    const mapped = mapDocumentRow(data);
    mapped.files = await hydrateFilesFromStorage(mapped.files);
    return mapped;
  } catch (err) {
    console.error("Exception fetching document from Supabase:", err);
    return null;
  }
};

export const subscribeToSupabaseDocumentChanges = (
  callback: (payload: any) => void,
) => {
  if (!supabase) {
    return () => {};
  }
  const channel = supabase
    .channel("canvas-sync-documents")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "documents" },
      (payload) => {
        callback(payload);
      },
    )
    .subscribe();

  return () => {
    supabase?.removeChannel(channel);
  };
};

export const subscribeToSupabaseFolderChanges = (
  callback: (payload: any) => void,
) => {
  if (!supabase) {
    return () => {};
  }
  const channel = supabase
    .channel("canvas-sync-folders")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "folders" },
      (payload) => {
        callback(payload);
      },
    )
    .subscribe();

  return () => {
    supabase?.removeChannel(channel);
  };
};

export const deleteDocumentFromSupabase = async (id: string): Promise<boolean> => {
  if (!supabase) {
    return false;
  }
  try {
    const user = await getSupabaseUser();
    if (user) {
      const { data: objects } = await supabase.storage
        .from("canvas-files")
        .list(`${user.id}/${id}`);
      if (objects && objects.length > 0) {
        await supabase.storage
          .from("canvas-files")
          .remove(objects.map((object) => `${user.id}/${id}/${object.name}`));
      }
    }

    const { error } = await supabase.from("documents").delete().eq("id", id);
    if (error) {
      console.error("Error deleting document from Supabase:", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Exception deleting document from Supabase:", err);
    return false;
  }
};
