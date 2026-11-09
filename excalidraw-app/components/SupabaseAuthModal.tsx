import React, { useState, useEffect } from "react";
import {
  supabase,
  isSupabaseConfigured,
  getSupabaseUser,
  fetchDocumentsFromSupabase,
} from "../data/supabase";
import { listDocuments, saveDocument } from "../data/documentStore";
import type { User } from "@supabase/supabase-js";

interface SupabaseAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSyncComplete?: () => void;
}

export const SupabaseAuthModal: React.FC<SupabaseAuthModalProps> = ({
  isOpen,
  onClose,
  onSyncComplete,
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
              ? "Signed up and logged in successfully!"
              : "Check your email to confirm your account.",
            type: "success",
          });
          onSyncComplete?.();
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
        }
      }
    } catch (err: any) {
      setMessage({ text: err.message || "Authentication error", type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleOAuth = async (provider: "google" | "github") => {
    if (!supabase) {
      return;
    }
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: window.location.origin,
        },
      });
      if (error) {
        setMessage({ text: error.message, type: "error" });
      }
    } catch (err: any) {
      setMessage({ text: err.message || "OAuth error", type: "error" });
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
      // 1. Pull cloud documents
      const cloudDocs = await fetchDocumentsFromSupabase();
      for (const cloudDoc of cloudDocs) {
        await saveDocument({
          id: cloudDoc.id,
          title: cloudDoc.title,
          elements: cloudDoc.elements,
          appState: cloudDoc.app_state,
          thumbnail: cloudDoc.thumbnail_url || undefined,
        }, false);
      }

      // 2. Push local documents to cloud
      const localDocs = await listDocuments();
      for (const localDoc of localDocs) {
        await saveDocument(localDoc, true);
      }

      setMessage({ text: "All drawings synced with Supabase successfully!", type: "success" });
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
      onClick={onClose}
    >
      <div
        className="documents-dashboard-modal"
        style={{ maxWidth: 480, height: "auto", maxHeight: "90vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dashboard-header">
          <div className="header-title-section">
            <h2>☁️ Supabase Cloud Sync</h2>
          </div>
          <button
            type="button"
            className="btn-close-dashboard"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: 18 }}>
          {!isSupabaseConfigured ? (
            <div style={{ lineHeight: 1.5, color: "var(--text-secondary-color)" }}>
              <p>
                <strong>Supabase is not configured yet.</strong>
              </p>
              <p>
                To enable multi-device cloud persistence, add your Supabase credentials to your environment variables:
              </p>
              <pre
                style={{
                  background: "var(--input-bg-color, #f1f3f5)",
                  padding: "12px",
                  borderRadius: "6px",
                  fontSize: "0.85rem",
                  overflowX: "auto",
                }}
              >
                {`VITE_SUPABASE_URL=https://your-project.supabase.co\nVITE_SUPABASE_ANON_KEY=your-anon-key`}
              </pre>
              <p>Your drawings are currently safely stored offline in high-capacity IndexedDB.</p>
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
                <div style={{ fontSize: "0.85rem", color: "var(--text-secondary-color)" }}>
                  Signed in as:
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
                  {loading ? "Syncing..." : "🔄 Sync All Drawings"}
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
              <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-secondary-color)" }}>
                Sign in to automatically sync your drawings and PDFs to Supabase across all your devices.
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: "0.85rem", fontWeight: 600 }}>Email</label>
                <input
                  type="email"
                  required
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{
                    padding: "8px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--default-border-color, #ced4da)",
                    background: "var(--input-bg-color, #ffffff)",
                    color: "inherit",
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
                    padding: "8px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--default-border-color, #ced4da)",
                    background: "var(--input-bg-color, #ffffff)",
                    color: "inherit",
                  }}
                />
              </div>

              <button
                type="submit"
                className="btn-new-drawing"
                style={{ justifyContent: "center", marginTop: 6 }}
                disabled={loading}
              >
                {loading ? "Processing..." : isSignUp ? "Create Account" : "Sign In"}
              </button>

              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  style={{
                    flex: 1,
                    padding: "8px",
                    borderRadius: "6px",
                    border: "1px solid var(--default-border-color, #ced4da)",
                    background: "transparent",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                  onClick={() => handleOAuth("google")}
                >
                  Google
                </button>
                <button
                  type="button"
                  style={{
                    flex: 1,
                    padding: "8px",
                    borderRadius: "6px",
                    border: "1px solid var(--default-border-color, #ced4da)",
                    background: "transparent",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                  onClick={() => handleOAuth("github")}
                >
                  GitHub
                </button>
              </div>

              <div style={{ textAlign: "center", fontSize: "0.85rem", marginTop: 4 }}>
                {isSignUp ? "Already have an account? " : "Don't have an account? "}
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
                  onClick={() => setIsSignUp(!isSignUp)}
                >
                  {isSignUp ? "Sign In" : "Sign Up"}
                </button>
              </div>
            </form>
          )}

          {message && (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: "6px",
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
