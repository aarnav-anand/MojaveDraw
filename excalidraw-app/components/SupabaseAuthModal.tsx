import React, { useState, useEffect } from "react";
import {
  supabase,
  isSupabaseConfigured,
  getSupabaseUser,
  fetchDocumentsFromSupabase,
  fetchFoldersFromSupabase,
} from "../data/supabase";
import {
  listDocuments,
  saveDocument,
  listFolders,
  saveFolder,
} from "../data/documentStore";
import type { User } from "@supabase/supabase-js";

interface SupabaseAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSyncComplete?: () => void;
  isInitialPrompt?: boolean;
}

export const SupabaseAuthModal: React.FC<SupabaseAuthModalProps> = ({
  isOpen,
  onClose,
  onSyncComplete,
  isInitialPrompt = false,
}) => {
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  useEffect(() => {
    if (isOpen && isSupabaseConfigured) {
      getSupabaseUser().then(setUser);
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) {
      return;
    }
    setLoading(true);
    setMessage(null);

    try {
      if (isSignUp) {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
        });
        if (error) {
          setMessage({ text: error.message, type: "error" });
        } else if (data.user) {
          setUser(data.user);
          setMessage({
            text: data.session
              ? "Account created & signed in successfully!"
              : "Account created! Check your email to confirm.",
            type: "success",
          });
          onSyncComplete?.();
          setTimeout(() => {
            onClose();
          }, 800);
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) {
          setMessage({ text: error.message, type: "error" });
        } else if (data.user) {
          setUser(data.user);
          setMessage({ text: "Signed in successfully!", type: "success" });
          onSyncComplete?.();
          setTimeout(() => {
            onClose();
          }, 600);
        }
      }
    } catch (err: any) {
      setMessage({ text: err.message || "Authentication error", type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    if (!supabase) {
      return;
    }
    setLoading(true);
    await supabase.auth.signOut();
    setUser(null);
    setMessage({ text: "Signed out successfully.", type: "success" });
    setLoading(false);
    onSyncComplete?.();
  };

  const handleSyncAll = async () => {
    setLoading(true);
    try {
      // 1. Pull cloud folders & documents
      const cloudFolders = await fetchFoldersFromSupabase();
      for (const cf of cloudFolders) {
        await saveFolder({
          id: cf.id,
          name: cf.name,
          parentId: cf.parent_id,
          createdAt: new Date(cf.created_at).getTime(),
          updatedAt: new Date(cf.updated_at).getTime(),
        });
      }

      const cloudDocs = await fetchDocumentsFromSupabase();
      for (const cloudDoc of cloudDocs) {
        await saveDocument(
          {
            id: cloudDoc.id,
            title: cloudDoc.title,
            folderId: cloudDoc.folder_id,
            elements: cloudDoc.elements,
            appState: cloudDoc.app_state,
            thumbnail: cloudDoc.thumbnail_url || undefined,
          },
          false,
        );
      }

      // 2. Push local folders and documents to cloud
      const localFolders = await listFolders();
      for (const f of localFolders) {
        await saveFolder(f);
      }

      const localDocs = await listDocuments();
      for (const localDoc of localDocs) {
        await saveDocument(localDoc, true);
      }

      setMessage({ text: "All drawings and folders synced with Supabase!", type: "success" });
      onSyncComplete?.();
    } catch (err: any) {
      setMessage({ text: err.message || "Failed to sync", type: "error" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="documents-dashboard-overlay"
      style={{ zIndex: 1200 }}
      onClick={isInitialPrompt ? undefined : onClose}
    >
      <div
        className="documents-dashboard-modal"
        style={{
          maxWidth: 420,
          height: "auto",
          maxHeight: "90vh",
          padding: 0,
          borderRadius: "14px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dashboard-header" style={{ padding: "18px 24px" }}>
          <div className="header-title-section">
            <h2>
              <span>☁️</span> {user ? "Supabase Account" : isSignUp ? "Create Account" : "Sign In"}
            </h2>
          </div>
          <button
            type="button"
            className="btn-close-dashboard"
            onClick={onClose}
            title="Close"
          >
            ✕
          </button>
        </div>

        <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: 16 }}>
          {!isSupabaseConfigured ? (
            <div style={{ lineHeight: 1.5, color: "var(--text-secondary-color)" }}>
              <p style={{ margin: "0 0 10px", fontWeight: 600, color: "var(--text-primary-color)" }}>
                Supabase credentials not detected
              </p>
              <p style={{ margin: "0 0 10px", fontSize: "0.9rem" }}>
                To enable multi-device cloud persistence, add your Supabase credentials to Vercel or your local environment:
              </p>
              <pre
                style={{
                  background: "var(--input-bg-color, #f1f3f5)",
                  padding: "10px",
                  borderRadius: "6px",
                  fontSize: "0.8rem",
                  overflowX: "auto",
                }}
              >
                {`VITE_SUPABASE_URL=...\nVITE_SUPABASE_ANON_KEY=...`}
              </pre>
              <p style={{ margin: "10px 0 0", fontSize: "0.85rem" }}>
                All your drawings and folders are currently stored securely in your browser's IndexedDB.
              </p>
              <button
                type="button"
                className="btn-new-drawing"
                style={{ marginTop: 14, width: "100%", justifyContent: "center" }}
                onClick={onClose}
              >
                Continue Offline
              </button>
            </div>
          ) : user ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div
                style={{
                  padding: "14px",
                  background: "var(--input-bg-color, #f8f9fa)",
                  borderRadius: "8px",
                  border: "1px solid var(--default-border-color, #dee2e6)",
                }}
              >
                <div style={{ fontSize: "0.8rem", color: "var(--text-secondary-color)" }}>
                  Signed in as
                </div>
                <div style={{ fontSize: "1.05rem", fontWeight: 600, marginTop: 4 }}>
                  {user.email}
                </div>
              </div>

              <div style={{ display: "flex", gap: 10 }}>
                <button
                  type="button"
                  className="btn-new-drawing"
                  style={{ flex: 1, justifyContent: "center" }}
                  disabled={loading}
                  onClick={handleSyncAll}
                >
                  {loading ? "Syncing..." : "🔄 Sync Drawings"}
                </button>
                <button
                  type="button"
                  style={{
                    background: "transparent",
                    border: "1px solid var(--default-border-color, #ced4da)",
                    borderRadius: "8px",
                    padding: "8px 16px",
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                  disabled={loading}
                  onClick={handleSignOut}
                >
                  Sign Out
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleAuth} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-secondary-color)", lineHeight: 1.4 }}>
                {isSignUp
                  ? "Create an account to store and access your drawings and notes from anywhere."
                  : "Sign in to access and sync your drawings across all your devices."}
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: "0.85rem", fontWeight: 600 }}>Email</label>
                <input
                  type="email"
                  required
                  autoFocus
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: "1.5px solid var(--default-border-color, #ced4da)",
                    background: "var(--input-bg-color, #ffffff)",
                    color: "inherit",
                    fontSize: "0.95rem",
                    outline: "none",
                  }}
                />
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: "0.85rem", fontWeight: 600 }}>Password</label>
                <input
                  type="password"
                  required
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: "1.5px solid var(--default-border-color, #ced4da)",
                    background: "var(--input-bg-color, #ffffff)",
                    color: "inherit",
                    fontSize: "0.95rem",
                    outline: "none",
                  }}
                />
              </div>

              <button
                type="submit"
                className="btn-new-drawing"
                style={{
                  justifyContent: "center",
                  marginTop: 6,
                  padding: "10px 16px",
                  fontSize: "0.95rem",
                  fontWeight: 600,
                }}
                disabled={loading}
              >
                {loading ? "Please wait..." : isSignUp ? "Create Account" : "Sign In"}
              </button>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginTop: 6,
                  fontSize: "0.85rem",
                }}
              >
                <button
                  type="button"
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--color-primary, #6965db)",
                    cursor: "pointer",
                    padding: 0,
                    fontWeight: 600,
                  }}
                  onClick={() => {
                    setIsSignUp(!isSignUp);
                    setMessage(null);
                  }}
                >
                  {isSignUp ? "Already have an account? Sign In" : "Need an account? Sign Up"}
                </button>

                <button
                  type="button"
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--text-secondary-color, #868e96)",
                    cursor: "pointer",
                    padding: 0,
                    textDecoration: "underline",
                  }}
                  onClick={onClose}
                >
                  Skip for now
                </button>
              </div>
            </form>
          )}

          {message && (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: "8px",
                fontSize: "0.85rem",
                background: message.type === "success" ? "#ebfbee" : "#fff5f5",
                color: message.type === "success" ? "#2b8a3e" : "#e03131",
                border: `1px solid ${message.type === "success" ? "#b2f2bb" : "#ffc9c9"}`,
              }}
            >
              {message.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
