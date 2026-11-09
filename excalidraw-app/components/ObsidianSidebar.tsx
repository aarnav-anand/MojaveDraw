import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  listDocuments,
  listFolders,
  createFolder,
  saveFolder,
  deleteFolder,
  duplicateDocument,
  deleteDocument,
  saveDocument,
  subscribeToStoreChanges,
} from "../data/documentStore";
import type { DocumentMetadata, FolderItem } from "../data/documentStore";
import { isSupabaseConfigured, getSupabaseUser } from "../data/supabase";
import {
  PlusIcon,
  TrashIcon,
  DuplicateIcon,
  searchIcon,
  pencilIcon,
  checkIcon,
} from "@excalidraw/excalidraw/components/icons";

import "./ObsidianSidebar.scss";

interface ObsidianSidebarProps {
  activeDocId: string;
  onSelectDoc: (id: string) => void;
  onRequestNewDrawing: (folderId?: string | null) => void;
  onOpenDashboard: () => void;
  onOpenAuthModal: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export const ObsidianSidebar: React.FC<ObsidianSidebarProps> = ({
  activeDocId,
  onSelectDoc,
  onRequestNewDrawing,
  onOpenDashboard,
  onOpenAuthModal,
  isCollapsed,
  onToggleCollapse,
}) => {
  const [documents, setDocuments] = useState<DocumentMetadata[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // Renaming state
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingType, setEditingType] = useState<"doc" | "folder" | null>(null);
  const [editTitle, setEditTitle] = useState("");

  // Prompt dialog for new folder
  const [folderPromptParentId, setFolderPromptParentId] = useState<string | null | false>(false);
  const [newFolderName, setNewFolderName] = useState("");
  const folderInputRef = useRef<HTMLInputElement>(null);

  const loadData = useCallback(async () => {
    const [docsList, foldersList] = await Promise.all([
      listDocuments(),
      listFolders(),
    ]);
    setDocuments(docsList);
    setFolders(foldersList);

    if (isSupabaseConfigured) {
      const user = await getSupabaseUser();
      setUserEmail(user?.email || null);
    }
  }, []);

  useEffect(() => {
    loadData();
    const unsubscribe = subscribeToStoreChanges(() => {
      loadData();
    });
    return () => unsubscribe();
  }, [loadData]);

  // Expand parent folder of active document on mount or activeDocId change
  useEffect(() => {
    if (activeDocId && documents.length > 0) {
      const currentDoc = documents.find((d) => d.id === activeDocId);
      if (currentDoc?.folderId) {
        setOpenFolders((prev) => ({ ...prev, [currentDoc.folderId!]: true }));
      }
    }
  }, [activeDocId, documents]);

  useEffect(() => {
    if (folderPromptParentId !== false) {
      setTimeout(() => {
        folderInputRef.current?.focus();
      }, 50);
    }
  }, [folderPromptParentId]);

  const toggleFolder = (folderId: string) => {
    setOpenFolders((prev) => ({
      ...prev,
      [folderId]: !prev[folderId],
    }));
  };

  const handleOpenFolderPrompt = (parentId: string | null) => {
    setNewFolderName("");
    setFolderPromptParentId(parentId);
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (folderPromptParentId === false) {
      return;
    }
    const name = newFolderName.trim() || "Untitled Folder";
    await createFolder(name, folderPromptParentId);
    if (folderPromptParentId) {
      setOpenFolders((prev) => ({ ...prev, [folderPromptParentId]: true }));
    }
    setFolderPromptParentId(false);
    setNewFolderName("");
    await loadData();
  };

  const handleStartRename = (
    e: React.MouseEvent,
    id: string,
    type: "doc" | "folder",
    currentTitle: string,
  ) => {
    e.stopPropagation();
    setEditingItemId(id);
    setEditingType(type);
    setEditTitle(currentTitle);
  };

  const handleSaveRename = async (e: React.SyntheticEvent, id: string) => {
    e.stopPropagation();
    if (!editTitle.trim()) {
      setEditingItemId(null);
      return;
    }

    if (editingType === "doc") {
      await saveDocument({ id, title: editTitle.trim() });
    } else if (editingType === "folder") {
      const folder = folders.find((f) => f.id === id);
      if (folder) {
        await saveFolder({ ...folder, name: editTitle.trim() });
      }
    }

    setEditingItemId(null);
    setEditingType(null);
    await loadData();
  };

  const handleDeleteFolder = async (e: React.MouseEvent, folder: FolderItem) => {
    e.stopPropagation();
    const confirmed = window.confirm(
      `Delete folder "${folder.name}" and all sub-folders? Drawings inside will be moved to the root level.`,
    );
    if (confirmed) {
      await deleteFolder(folder.id);
      await loadData();
    }
  };

  const handleDeleteDoc = async (e: React.MouseEvent, doc: DocumentMetadata) => {
    e.stopPropagation();
    const confirmed = window.confirm(`Delete drawing "${doc.title}"?`);
    if (confirmed) {
      await deleteDocument(doc.id);
      await loadData();
    }
  };

  const handleDuplicateDoc = async (e: React.MouseEvent, docId: string) => {
    e.stopPropagation();
    const copy = await duplicateDocument(docId);
    if (copy) {
      await loadData();
    }
  };

  // Filter items
  const filteredDocs = searchQuery.trim()
    ? documents.filter((d) =>
        d.title.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : documents;

  // Recursive folder tree component
  const renderFolder = (folder: FolderItem, depth = 0) => {
    const isFolderOpen = !!openFolders[folder.id];
    const subFolders = folders.filter((f) => f.parentId === folder.id);
    const folderDocs = filteredDocs.filter((d) => d.folderId === folder.id);
    const isEditing = editingItemId === folder.id && editingType === "folder";

    return (
      <div key={folder.id} className="obsidian-folder-wrapper">
        <div
          className="obsidian-item-row obsidian-folder-row"
          style={{ paddingLeft: `${depth * 14 + 10}px` }}
          onClick={() => toggleFolder(folder.id)}
        >
          <span className="folder-chevron">
            {isFolderOpen ? "▾" : "▸"}
          </span>
          <span className="folder-icon">{isFolderOpen ? "📂" : "📁"}</span>

          {isEditing ? (
            <input
              type="text"
              className="inline-rename-input"
              value={editTitle}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSaveRename(e, folder.id);
                } else if (e.key === "Escape") {
                  setEditingItemId(null);
                }
              }}
              onBlur={(e) => handleSaveRename(e, folder.id)}
            />
          ) : (
            <span className="item-title" title={folder.name}>
              {folder.name}
            </span>
          )}

          <div className="item-hover-actions">
            {isEditing ? (
              <button
                type="button"
                className="action-btn"
                title="Save"
                onClick={(e) => handleSaveRename(e, folder.id)}
              >
                {checkIcon}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="action-btn"
                  title="New Drawing Inside"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenFolders((prev) => ({ ...prev, [folder.id]: true }));
                    onRequestNewDrawing(folder.id);
                  }}
                >
                  ✏️
                </button>
                <button
                  type="button"
                  className="action-btn"
                  title="New Sub-folder"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleOpenFolderPrompt(folder.id);
                  }}
                >
                  📁
                </button>
                <button
                  type="button"
                  className="action-btn"
                  title="Rename Folder"
                  onClick={(e) =>
                    handleStartRename(e, folder.id, "folder", folder.name)
                  }
                >
                  {pencilIcon}
                </button>
                <button
                  type="button"
                  className="action-btn delete-btn"
                  title="Delete Folder"
                  onClick={(e) => handleDeleteFolder(e, folder)}
                >
                  {TrashIcon}
                </button>
              </>
            )}
          </div>
        </div>

        {isFolderOpen && (
          <div className="obsidian-folder-children">
            {subFolders.map((sub) => renderFolder(sub, depth + 1))}
            {folderDocs.map((doc) => renderDocument(doc, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const renderDocument = (doc: DocumentMetadata, depth = 0) => {
    const isActive = doc.id === activeDocId;
    const isEditing = editingItemId === doc.id && editingType === "doc";

    return (
      <div
        key={doc.id}
        className={`obsidian-item-row obsidian-doc-row ${
          isActive ? "active-doc" : ""
        }`}
        style={{ paddingLeft: `${depth * 14 + 12}px` }}
        onClick={() => onSelectDoc(doc.id)}
      >
        <span className="doc-icon">✏️</span>

        {isEditing ? (
          <input
            type="text"
            className="inline-rename-input"
            value={editTitle}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSaveRename(e, doc.id);
              } else if (e.key === "Escape") {
                setEditingItemId(null);
              }
            }}
            onBlur={(e) => handleSaveRename(e, doc.id)}
          />
        ) : (
          <span className="item-title" title={doc.title}>
            {doc.title}
          </span>
        )}

        {doc.syncedToCloud && (
          <span className="cloud-indicator" title="Synced to Supabase">
            ☁️
          </span>
        )}

        <div className="item-hover-actions">
          {isEditing ? (
            <button
              type="button"
              className="action-btn"
              title="Save"
              onClick={(e) => handleSaveRename(e, doc.id)}
            >
              {checkIcon}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="action-btn"
                title="Rename Drawing"
                onClick={(e) => handleStartRename(e, doc.id, "doc", doc.title)}
              >
                {pencilIcon}
              </button>
              <button
                type="button"
                className="action-btn"
                title="Duplicate"
                onClick={(e) => handleDuplicateDoc(e, doc.id)}
              >
                {DuplicateIcon}
              </button>
              <button
                type="button"
                className="action-btn delete-btn"
                title="Delete"
                onClick={(e) => handleDeleteDoc(e, doc)}
              >
                {TrashIcon}
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  if (isCollapsed) {
    return (
      <div className="obsidian-sidebar-collapsed">
        <button
          type="button"
          className="btn-expand-sidebar"
          onClick={onToggleCollapse}
          title="Expand Explorer Sidebar"
        >
          <span>📁</span>
          <span>›</span>
        </button>
      </div>
    );
  }

  const folderIdSet = new Set(folders.map((f) => f.id));
  const rootFolders = folders.filter((f) => !f.parentId || !folderIdSet.has(f.parentId));
  const rootDocs = filteredDocs.filter((d) => !d.folderId || !folderIdSet.has(d.folderId));

  return (
    <aside className="obsidian-sidebar">
      {/* Top Header */}
      <div className="obsidian-header">
        <div className="vault-brand">
          <span className="brand-icon">🎨</span>
          <span className="brand-name">MojaveDraw</span>
        </div>

        <div className="header-icon-actions">
          <button
            type="button"
            className="header-action-btn"
            title="New Drawing"
            onClick={() => onRequestNewDrawing(null)}
          >
            {PlusIcon}
          </button>
          <button
            type="button"
            className="header-action-btn"
            title="New Folder"
            onClick={() => handleOpenFolderPrompt(null)}
          >
            📁
          </button>
          <button
            type="button"
            className="header-action-btn"
            title="Gallery View"
            onClick={onOpenDashboard}
          >
            🖼️
          </button>
          <button
            type="button"
            className="header-action-btn"
            title="Collapse Sidebar"
            onClick={onToggleCollapse}
          >
            ◀
          </button>
        </div>
      </div>

      {/* Quick Search */}
      <div className="obsidian-search-bar">
        <span className="search-icon">{searchIcon}</span>
        <input
          type="text"
          placeholder="Search files..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button
            type="button"
            className="clear-search-btn"
            onClick={() => setSearchQuery("")}
          >
            ✕
          </button>
        )}
      </div>

      {/* File Tree List */}
      <div className="obsidian-tree-container">
        {rootFolders.map((f) => renderFolder(f, 0))}
        {rootDocs.map((doc) => renderDocument(doc, 0))}

        {rootFolders.length === 0 && rootDocs.length === 0 && (
          <div className="empty-tree-state">
            <p>No drawings found.</p>
            <button
              type="button"
              className="btn-create-first"
              onClick={() => onRequestNewDrawing(null)}
            >
              + Create Drawing
            </button>
          </div>
        )}
      </div>

      {/* New Folder Modal / Prompt */}
      {folderPromptParentId !== false && (
        <div
          className="folder-prompt-overlay"
          onClick={() => setFolderPromptParentId(false)}
        >
          <div
            className="folder-prompt-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <h4>
              {folderPromptParentId ? "New Sub-folder" : "New Folder"}
            </h4>
            <form onSubmit={handleCreateFolder}>
              <input
                ref={folderInputRef}
                type="text"
                placeholder="Folder name..."
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setFolderPromptParentId(false);
                  }
                }}
              />
              <div className="prompt-actions">
                <button
                  type="button"
                  className="btn-cancel"
                  onClick={() => setFolderPromptParentId(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-confirm">
                  Create Folder
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Footer Profile / Cloud Sync Info */}
      <div className="obsidian-footer">
        {userEmail ? (
          <div className="user-profile-row" onClick={onOpenAuthModal} title="Manage Account & Sync">
            <div className="user-avatar">{userEmail.charAt(0).toUpperCase()}</div>
            <div className="user-details">
              <span className="user-email">{userEmail}</span>
              <span className="user-status">☁️ Synced to Supabase</span>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn-sidebar-auth"
            onClick={onOpenAuthModal}
          >
            <span>☁️</span>
            <span>Sign In / Sync</span>
          </button>
        )}
      </div>
    </aside>
  );
};
