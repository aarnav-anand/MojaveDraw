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

export const uploadFileToSupabaseStorage = async (
  fileId: string,
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

    // Convert dataURL to Blob
    const response = await fetch(fileData.dataURL);
    const blob = await response.blob();
    const filePath = `${user.id}/${fileId}`;

    const { error } = await supabase.storage
      .from("canvas-files")
      .upload(filePath, blob, {
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

    // Optionally upload embedded files
    if (doc.files) {
      const uploadPromises = Object.entries(doc.files).map(async ([fileId, fileData]) => {
        if (fileData) {
          await uploadFileToSupabaseStorage(fileId, fileData);
        }
      });
      await Promise.all(uploadPromises);
    }

    const payload: any = {
      id: doc.id,
      user_id: user.id,
      title: doc.title || "Untitled Drawing",
      elements: doc.elements,
      app_state: doc.appState,
      thumbnail_url: doc.thumbnail || null,
      updated_at: new Date().toISOString(),
    };

    if (doc.folderId !== undefined) {
      payload.folder_id = doc.folderId;
    }

    let { error } = await supabase.from("documents").upsert(payload, { onConflict: "id" });

    // Fallback if folder_id column or foreign key doesn't exist yet in Supabase
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
      .select("id, user_id, title, folder_id, elements, app_state, thumbnail_url, created_at, updated_at")
      .order("updated_at", { ascending: false });

    // Fallback if folder_id does not exist in schema yet
    if (error && error.message?.includes("folder_id")) {
      const fallback = await supabase
        .from("documents")
        .select("id, user_id, title, elements, app_state, thumbnail_url, created_at, updated_at")
        .order("updated_at", { ascending: false });
      data = fallback.data as any;
      error = fallback.error;
    }

    if (error || !data) {
      console.error("Error fetching documents from Supabase:", error);
      return [];
    }
    return data as SupabaseDocumentRecord[];
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
      .order("created_at", { ascending: true });

    if (error) {
      // Table might not exist yet if user hasn't run the migration
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
    const { data, error } = await supabase
      .from("documents")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) {
      return null;
    }
    return data as SupabaseDocumentRecord;
  } catch (err) {
    console.error("Exception fetching document from Supabase:", err);
    return null;
  }
};

export const deleteDocumentFromSupabase = async (id: string): Promise<boolean> => {
  if (!supabase) {
    return false;
  }
  try {
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
