"use client";

import Logo from "@/components/Logo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowDownToLine, ArrowUpRight, Check, ChevronRight, CloudUpload, Copy, Eye, File, FileImage, Folder, FolderPlus, HardDrive, Link2, Loader2, LogOut, MoreHorizontal, Pencil, RefreshCw, Search, ShieldCheck, Trash2, X } from "lucide-react";
import Link from "next/link";
import type { Connection } from "./Workspace";
import type { Session } from "@/lib/auth";
import FilePreview, { canPreview } from "./FilePreview";

type FileRecord = { id: string; name: string; contentType: string; sizeBytes: number; status: string; folderId: string | null; updatedAt: string };
type FolderRecord = { id: string; name: string; parentId: string | null };
type LinkRecord = { id: string; expiresAt: string; revokedAt: string | null; passwordProtected: boolean };
type Modal = { type: "folder" } | { type: "renameFolder"; folder: FolderRecord } | { type: "actions" | "rename" | "share" | "trash" | "purge"; file: FileRecord };
type Listing = { files: FileRecord[]; folders: FolderRecord[]; quota: { usedBytes: number; quotaBytes: number | null } };

function storageApi(storageId: string) { return async function api<T = Record<string, unknown>>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, { method, cache: "no-store", ...(body === undefined ? { headers: { "x-storage-id": storageId } } : { headers: { "Content-Type": "application/json", "x-storage-id": storageId }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (response.status === 401) { window.location.reload(); throw new Error("Please sign in again."); }
  if (!response.ok) throw new Error(data.message ?? "Request failed. Please try again.");
  return data as T;
}; }
function putFile(url: string, body: Blob, progress: (bytes: number) => void, type?: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open("PUT", url);
    if (type) xhr.setRequestHeader("Content-Type", type);
    for (const [key, value] of Object.entries(headers ?? {})) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (event) => progress(event.loaded);
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.getResponseHeader("ETag")) : reject(new Error(`Storage rejected the transfer (${xhr.status}). Please retry.`));
    xhr.onerror = () => reject(new Error("Transfer interrupted. Check your connection and retry."));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    xhr.ontimeout = () => reject(new Error("Transfer timed out. Please retry."));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    if (signal?.aborted) { xhr.abort(); return; }
    xhr.timeout = 30 * 60 * 1000; xhr.send(body);
  });
}

export default function Dashboard({ session, storage, storageNavigation, guestNavigation, onTransferChange }: { session: Session; storage: Connection; storageNavigation: React.ReactNode; guestNavigation?: React.ReactNode; onTransferChange: (busy: boolean) => void }) {
  const api = useMemo(() => storageApi(storage.id), [storage.id]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [path, setPath] = useState<FolderRecord[]>([]);
  const [trash, setTrash] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [upload, setUpload] = useState<{ name: string; percent: number; index: number; total: number } | null>(null);
  const [preview, setPreview] = useState<FileRecord | null>(null);
  const [dragging, setDragging] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [days, setDays] = useState(7);
  const [links, setLinks] = useState<LinkRecord[]>([]);
  const [linkUrl, setLinkUrl] = useState("");
  const [modalError, setModalError] = useState("");
  const [busy, setBusy] = useState(false);
  const [linksLoading, setLinksLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [linkCheckTime, setLinkCheckTime] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const uploadBusy = useRef(false);
  const uploadCancel = useRef<AbortController | null>(null);
  const activeUploadId = useRef<string | null>(null);
  const loadSequence = useRef(0);
  const syncStarted = useRef(false);
  const currentLoad = useRef<() => Promise<void>>(async () => {});
  const folderId = path.at(-1)?.id ?? null;
  const readOnly = session.role === "readonly";

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current; setLoading(true);
    const params = new URLSearchParams();
    if (folderId) params.set("folderId", folderId);
    if (query.trim()) params.set("q", query.trim());
    if (trash) params.set("trash", "1");
    try { const body = await api<Listing>(`/api/files?${params}`); if (sequence === loadSequence.current) setListing(body); }
    catch (error) { if (sequence === loadSequence.current) setNotice({ text: message(error), error: true }); }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [folderId, query, trash, api]);
  useEffect(() => {
    currentLoad.current = load;
    const timer = setTimeout(() => { void load(); }, 0);
    // This is a request sequence counter, not a DOM ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { clearTimeout(timer); loadSequence.current++; };
  }, [load]);
  useEffect(() => {
    if (syncStarted.current) return;
    syncStarted.current = true;
    void api<{ skipped: number }>("/api/storage/sync", "POST").then(async (result) => {
      if (result.skipped) setNotice({ text: `${result.skipped} unsupported bucket paths could not be imported.`, error: true });
      await currentLoad.current();
    }).catch((error) => setNotice({ text: `Bucket sync: ${message(error)}`, error: true }));
  }, [api]);
  useEffect(() => { onTransferChange(!!upload); }, [upload, onTransferChange]);
  useEffect(() => { if (modal) dialogRef.current?.showModal(); else dialogRef.current?.close(); }, [modal]);
  useEffect(() => {
    if (!upload) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [upload]);

  async function sync() {
    if (syncing) return; setSyncing(true);
    try {
      const result = await api<{ imported: number; scanned: number; skipped: number }>("/api/storage/sync", "POST");
      setNotice({ text: `Bucket synced. ${result.scanned} objects checked, ${result.imported} files added.${result.skipped ? ` ${result.skipped} unsupported paths skipped.` : ""}`, error: result.skipped > 0 });
      await currentLoad.current();
    } catch (error) { setNotice({ text: message(error), error: true }); }
    finally { setSyncing(false); }
  }
  async function uploadFiles(selected: FileList | null) {
    if (!selected?.length || uploadBusy.current || trash || readOnly) return;
    uploadBusy.current = true; uploadCancel.current = new AbortController();
    const batch = Array.from(selected); let succeeded = 0; const failures: string[] = [];
    for (let index = 0; index < batch.length; index++) {
      const file = batch[index];
      const update = (bytes: number) => setUpload({ name: file.name, percent: Math.min(99, file.size ? Math.round(bytes / file.size * 100) : 99), index: index + 1, total: batch.length });
      if (uploadCancel.current.signal.aborted) break;
      update(0); let uploadId: string | undefined;
      try {
        const init = await api<{ uploadId: string; mode: string; url: string; headers?: Record<string, string>; partCount: number; partBytes: number }>("/api/files", "POST", { name: file.name, sizeBytes: file.size, contentType: file.type, folderId, idempotencyKey: crypto.randomUUID() });
        uploadId = init.uploadId; activeUploadId.current = uploadId; const parts: Array<{ partNumber: number; etag: string }> = [];
        if (init.mode === "single") await putFile(init.url, file, update, file.type || "application/octet-stream", init.headers, uploadCancel.current.signal);
        else if (init.mode === "multipart") {
          for (let partNumber = 1; partNumber <= init.partCount; partNumber++) {
            const part = await api<{ url: string }>(`/api/uploads/${uploadId}/part?partNumber=${partNumber}`);
            const start = (partNumber - 1) * init.partBytes;
            const etag = await putFile(part.url, file.slice(start, Math.min(start + init.partBytes, file.size)), (bytes) => update(start + bytes), undefined, undefined, uploadCancel.current.signal);
            if (!etag) throw new Error("Storage did not expose the part ETag."); parts.push({ partNumber, etag });
          }
        } else if (init.mode !== "completed") throw new Error("Unexpected upload response.");
        if (init.mode !== "completed") await api(`/api/uploads/${uploadId}/complete`, "POST", { parts });
        succeeded++;
      } catch (error) {
        if (uploadId) await api(`/api/uploads/${uploadId}/abort`, "POST").catch(() => undefined);
        failures.push(`${file.name}: ${error instanceof DOMException && error.name === "AbortError" ? "cancelled" : message(error)}`);
      }
      activeUploadId.current = null;
    }
    setUpload(null); uploadBusy.current = false; uploadCancel.current = null; activeUploadId.current = null;
    if (inputRef.current) inputRef.current.value = "";
    setNotice({ text: failures.length ? `${succeeded} uploaded. ${failures.join(" ")}` : `${succeeded} file${succeeded === 1 ? "" : "s"} uploaded and verified.`, error: failures.length > 0 });
    await currentLoad.current();
  }
  async function cancelUpload() { uploadCancel.current?.abort(); const id = activeUploadId.current; if (id) await api(`/api/uploads/${id}/abort`, "POST").catch(() => undefined); }
  async function refreshLinks(file: FileRecord) {
    setLinksLoading(true); setLinkCheckTime(Date.now());
    try { setLinks((await api<{ shares: LinkRecord[] }>(`/api/shares?fileId=${file.id}`)).shares); }
    catch (error) { setModalError(message(error)); }
    finally { setLinksLoading(false); }
  }
  function openModal(next: Modal) {
    setModalError(""); setLinkUrl(""); setCopied(false); setPassword(""); setDays(7); setLinks([]);
    setName("file" in next ? next.file.name : "folder" in next ? next.folder.name : ""); setModal(next);
    if (next.type === "share") void refreshLinks(next.file);
  }
  async function download(file: FileRecord) {
    try { const result = await api<{ url: string }>(`/api/files/${file.id}/download`); window.location.assign(result.url); }
    catch (error) { setNotice({ text: message(error), error: true }); }
  }
  async function mutate(operation: () => Promise<unknown>, success: string, keepOpen = false) {
    if (busy) return; setBusy(true); setModalError("");
    try { await operation(); if (!keepOpen) setModal(null); setNotice({ text: success }); await currentLoad.current(); }
    catch (error) { setModalError(message(error)); setNotice({ text: message(error), error: true }); }
    finally { setBusy(false); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!modal) return;
    if (modal.type === "folder") await mutate(() => api("/api/folders", "POST", { name, parentId: folderId }), "Folder created.");
    if (modal.type === "renameFolder") await mutate(() => api(`/api/folders/${modal.folder.id}`, "PATCH", { name }), "Folder renamed.");
    if (modal.type === "rename") await mutate(() => api(`/api/files/${modal.file.id}`, "PATCH", { name }), "File renamed.");
    if (modal.type === "trash" || modal.type === "purge") await mutate(() => api(`/api/files/${modal.file.id}?action=${modal.type}`, "DELETE"), modal.type === "trash" ? "Moved to trash." : "Permanently deleted from storage.");
    if (modal.type === "share") await mutate(async () => {
      const result = await api<{ url: string }>("/api/shares", "POST", { fileId: modal.file.id, expiresInDays: days, ...(password ? { password } : {}) });
      setLinkUrl(result.url); setCopied(false); await refreshLinks(modal.file);
    }, "Share link created. Copy it below.", true);
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(linkUrl); setCopied(true); }
    catch { setModalError("Clipboard unavailable. Select and copy the link below."); }
  }
  const activeFiles = listing?.files ?? [];
  const visibleFolders = (listing?.folders ?? []).filter((folder) => !query || folder.name.toLowerCase().includes(query.toLowerCase()));
  const title = trash ? "Trash" : path.at(-1)?.name ?? "Your files";

  return <main className="app-shell">
    <aside className="sidebar">
      <Link href="/" className="brand"><span className="brand-symbol"><Logo /></span><span>salva<span className="brand-light"> / cloud</span></span></Link>
      {storageNavigation}<div className="sidebar-section"><p className="eyebrow">WORKSPACE</p><nav aria-label="Workspace"><button className={`nav-item ${!trash ? "active" : ""}`} onClick={() => { setTrash(false); setPath([]); setQuery(""); }}><Archive size={18} />All files<ChevronRight size={14} /></button>{guestNavigation}{!readOnly&&<button className={`nav-item ${trash ? "active" : ""}`} onClick={() => { setTrash(true); setPath([]); setQuery(""); }}><Trash2 size={18} />Trash</button>}</nav></div>
      <div className="storage-card"><div className="storage-caption"><HardDrive size={18} /><span>{storage.name}</span></div><p className="storage-amount">{listing ? formatBytes(listing.quota.usedBytes) : "…"}<span> of {listing?.quota.quotaBytes ? formatBytes(listing.quota.quotaBytes) : "unreported capacity"}</span></p>{listing?.quota.quotaBytes && <progress aria-label="Storage used" value={listing.quota.usedBytes} max={listing.quota.quotaBytes} />}<p className="storage-note">Includes files in trash.</p></div>
      <div className="sidebar-bottom"><span className="private-note"><ShieldCheck size={15} /> Private by default</span><div className="user-chip"><span className="avatar">{session.displayName.slice(0, 1)}</span><span className="user-info"><strong>{session.displayName}</strong><span title={session.email}>{session.email}</span></span><button className="icon-button" aria-label="Sign out" onClick={() => void mutate(async () => { await api("/api/auth/logout", "POST"); window.location.reload(); }, "Signed out.")}><LogOut size={17} /></button></div></div>
    </aside>
    <section className={`workspace ${dragging ? "dragging" : ""}`} onDragOver={(event) => { if (!trash && event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); void uploadFiles(event.dataTransfer.files); }}>
      <header className="topbar"><span className="workspace-label">PERSONAL WORKSPACE</span><span className="private-note"><span className="status-dot" />Owner access</span></header>
      <div className="content-wrap">
        <div className="page-heading dashboard-heading"><div><p className="eyebrow">{storage.kind === "s3" ? "OBJECT STORAGE WORKSPACE" : storage.kind === "webdav" ? "WEBDAV WORKSPACE" : "PRIVATE NAS WORKSPACE"}</p><h1>{title}</h1><p className="page-description">{trash ? "Restore retained files or remove them permanently." : `Operating on ${storage.name} · ${storage.bucket ?? (storage.kind === "webdav" ? "WebDAV directory" : "private NAS directory")}`}</p></div>{!trash && !readOnly && <button className="button button-primary" disabled={!!upload} onClick={() => inputRef.current?.click()}><CloudUpload size={18} />Upload files</button>}</div>
        {!trash && <section className="workspace-overview" aria-label="Storage overview"><div><small>USED CAPACITY</small><strong>{listing ? formatBytes(listing.quota.usedBytes) : "·"}</strong><span>{listing?.quota.quotaBytes ? `${Math.round(listing.quota.usedBytes / listing.quota.quotaBytes * 100)}% of limit` : "Provider capacity unreported"}</span></div><div><small>THIS LOCATION</small><strong>{activeFiles.length}</strong><span>indexed files</span></div><div><small>FOLDERS</small><strong>{visibleFolders.length}</strong><span>in current path</span></div><div><small>CONNECTION</small><strong className="overview-online">Live</strong><span>{storage.kind === "s3" ? storage.region ?? "S3" : storage.kind === "webdav" ? "WebDAV gateway" : "NAS agent"}</span></div></section>}
        <input ref={inputRef} className="visually-hidden" type="file" aria-label="Choose files to upload" multiple onChange={(event) => void uploadFiles(event.target.files)} />
        {notice && <div className={`notice ${notice.error ? "notice-error" : ""}`} role={notice.error ? "alert" : "status"}><span>{notice.text}</span><button className="icon-button" onClick={() => setNotice(null)} aria-label="Dismiss notification"><X size={16} /></button></div>}
        {upload && <div className="upload-banner" role="status"><CloudUpload size={22} /><div><strong>{upload.percent === 99 ? "Verifying" : "Uploading"} {upload.name}</strong><span>{upload.index} of {upload.total} · Keep this tab open</span><progress value={upload.percent} max={100} aria-label="Upload progress" /></div><span>{upload.percent}%</span><button className="upload-cancel" onClick={() => void cancelUpload()} aria-label="Cancel upload"><X size={15} /></button></div>}
        <div className="toolbar"><label className="search-box"><Search size={18} /><input aria-label="Search this folder" placeholder={trash ? "Search trash…" : "Search this folder…"} value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button className="icon-button" aria-label="Clear search" onClick={() => setQuery("")}><X size={14} /></button>}</label><div className="toolbar-actions">{!readOnly && <button className="button button-quiet" disabled={syncing || !!upload} onClick={() => void sync()}><RefreshCw size={16} className={syncing ? "spinning" : ""} /><span>{syncing ? "Syncing…" : "Sync bucket"}</span></button>}{!trash && !readOnly && <button className="button button-quiet" onClick={() => openModal({ type: "folder" })}><FolderPlus size={17} /><span>New folder</span></button>}</div></div>
        <nav className="breadcrumbs" aria-label="Folder path"><button onClick={() => { setPath([]); setQuery(""); }}>{trash ? "Trash" : "All files"}</button>{!trash && path.map((folder, index) => <span key={folder.id}><ChevronRight size={13} /><button onClick={() => { setPath(path.slice(0, index + 1)); setQuery(""); }}>{folder.name}</button></span>)}</nav>
        {trash && <p className="retention-note">Trash counts toward storage. Files are permanently deleted after 30 days. Deleting imported files also removes the original storage object.</p>}
        {!loading && visibleFolders.length > 0 && <section className="folders-section" aria-label="Folders"><div className="section-heading"><h2>Folders</h2><span>{visibleFolders.length}</span></div><div className="folder-grid">{visibleFolders.map((folder) => <div className="folder-tile" key={folder.id}><button className="folder-open" onClick={() => { setPath([...path, folder]); setQuery(""); }}><Folder size={26} strokeWidth={1.6} /><strong>{folder.name}</strong><ChevronRight size={16} /></button><button className="icon-button" aria-label={`Rename folder ${folder.name}`} onClick={() => openModal({ type: "renameFolder", folder })}><Pencil size={14} /></button></div>)}</div></section>}
        <section className="files-section" aria-label="Files" aria-busy={loading}><div className="section-heading"><h2>{trash ? "Deleted files" : "Files"}</h2><span>{loading ? "Refreshing…" : `${activeFiles.length} items`}</span></div><div className="file-table"><div className="file-row file-head"><span>NAME</span><span>SIZE</span><span>MODIFIED</span><span className="align-right">ACTIONS</span></div>
          {loading ? <div className="loading-state"><Loader2 className="spinning" size={22} /><span>Getting your files…</span></div> : activeFiles.map((file) => <div className="file-row" key={file.id}><div className="file-name"><span className={`file-icon ${file.contentType.startsWith("image/") ? "image-icon" : ""}`}>{file.contentType.startsWith("image/") ? <FileImage size={21} strokeWidth={1.5} /> : <File size={21} strokeWidth={1.5} />}</span><div><button className="file-title" onClick={() => openModal({ type: "actions", file })}>{file.name}</button><span className="file-subtitle">{file.status === "ready" ? file.contentType.split("/").at(-1)?.toUpperCase() : file.status.replace("_", " ")}</span></div></div><span className="file-size">{formatBytes(file.sizeBytes)}</span><span className="file-date">{formatDate(file.updatedAt)}</span><div className="row-actions">{!trash && file.status === "ready" && <>{canPreview(file) && <button className="icon-button desktop-action" aria-label={`Preview ${file.name}`} onClick={() => setPreview(file)}><Eye size={17} /></button>}<button className="icon-button desktop-action" aria-label={`Download ${file.name}`} onClick={() => void download(file)}><ArrowDownToLine size={17} /></button>{!readOnly && <button className="icon-button desktop-action" aria-label={`Share ${file.name}`} onClick={() => openModal({ type: "share", file })}><Link2 size={17} /></button>}</>}<button className="icon-button" aria-label={`Manage ${file.name}`} onClick={() => openModal({ type: "actions", file })}><MoreHorizontal size={20} /></button></div></div>)}
          {!loading && !activeFiles.length && <div className="empty-state"><span className="empty-icon">{trash ? <Trash2 size={28} /> : <CloudUpload size={30} />}</span><h3>{query ? "No matching files" : trash ? "Nothing in the trash" : "A place for what matters"}</h3><p>{query ? "Try another name or clear your search." : trash ? "Files you delete will appear here for 30 days." : "Drop files here, or choose something to upload."}</p>{!query && !trash && <button className="button button-quiet" disabled={!!upload} onClick={() => inputRef.current?.click()}>Choose files<ArrowUpRight size={15} /></button>}</div>}
        </div></section><footer className="workspace-footer"><span><ShieldCheck size={14} />Your bucket. Your control.</span><span>{storage.kind === "s3" ? "S3 object storage" : storage.kind === "webdav" ? "WebDAV via gateway" : "Private NAS"}</span></footer>
      </div>{dragging && <div className="drop-overlay"><CloudUpload size={40} /><strong>Drop to upload here</strong><span>{path.at(-1)?.name ?? "All files"}</span></div>}
    </section>
    <dialog ref={dialogRef} className="modal" aria-label="Manage files and links" onCancel={(event) => { if (busy) event.preventDefault(); else setModal(null); }} onClick={(event) => { if (event.target === event.currentTarget && !busy) setModal(null); }}>
      {modal && <div className="modal-content"><div className="modal-header"><span className="eyebrow">{modal.type === "share" ? "SHARE WITH CARE" : "YOUR WORKSPACE"}</span><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={() => setModal(null)}><X size={20} /></button></div><h2>{modal.type === "folder" ? "New folder" : modal.type === "renameFolder" ? "Rename folder" : modal.type === "rename" ? "Rename file" : modal.type === "share" ? "Share a file" : modal.type === "purge" ? "Delete permanently?" : modal.type === "trash" ? "Move to trash?" : modal.file.name}</h2>{"file" in modal && modal.type !== "actions" && <p className="modal-file">{modal.file.name}</p>}{modalError && <p className="form-error" role="alert">{modalError}</p>}
      {modal.type === "actions" ? <><p className="muted">{formatBytes(modal.file.sizeBytes)} · {formatDate(modal.file.updatedAt)}</p><div className="action-list">{modal.file.status === "ready" ? <>{canPreview(modal.file) && <button onClick={() => { setPreview(modal.file); setModal(null); }}><Eye size={19} />Preview<ArrowUpRight size={15} /></button>}<button onClick={() => { void download(modal.file); setModal(null); }}><ArrowDownToLine size={19} />Download<ArrowUpRight size={15} /></button>{!readOnly && <><button onClick={() => openModal({ type: "share", file: modal.file })}><Link2 size={19} />Share & manage links<ChevronRight size={15} /></button><button onClick={() => openModal({ type: "rename", file: modal.file })}><Pencil size={19} />Rename display name</button><button className="danger-text" onClick={() => openModal({ type: "trash", file: modal.file })}><Trash2 size={19} />Move to trash</button></>}</> : trash ? <>{readOnly ? <p>Read-only access cannot restore or permanently delete files.</p> : <>{modal.file.status === "trashed" && <button disabled={busy} onClick={() => void mutate(() => api(`/api/files/${modal.file.id}?action=restore`, "DELETE"), "File restored.")}><Archive size={19} />Restore file</button>}<button className="danger-text" onClick={() => openModal({ type: "purge", file: modal.file })}><Trash2 size={19} />Delete permanently</button></>}</> : <p>Upload is not complete yet. Refresh after the transfer finishes.</p>}</div></> : <form onSubmit={(event) => void submit(event)}>
        {["folder", "rename", "renameFolder"].includes(modal.type) && <label className="field-label">Name<input className="text-input" autoFocus required maxLength={255} value={name} onChange={(event) => setName(event.target.value)} placeholder="Give it a name" /></label>}
        {modal.type === "renameFolder" && <p className="helper">Only empty folders can be renamed. This also renames the folder in storage.</p>}{modal.type === "rename" && <p className="helper">Changes the display name. The original storage key stays unchanged.</p>}
        {modal.type === "trash" && <p className="modal-copy">This file will stop being downloadable and shared links will stop working. You can restore it for 30 days before permanent deletion.</p>}
        {modal.type === "purge" && <p className="modal-copy">This removes the actual object from this storage, including files imported from another application. Other apps using this object will lose access. This cannot be undone.</p>}
        {modal.type === "share" && <><div className="form-grid"><label className="field-label">Expires in<select className="text-input" value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option></select></label><label className="field-label">Password <span className="optional">optional</span><input className="text-input" type="password" autoComplete="new-password" minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" /></label></div><p className="helper">Anyone with the link can download unless you set a password.</p></>}
        <div className="modal-buttons"><button type="button" className="button button-quiet" disabled={busy} onClick={() => setModal(null)}>Cancel</button><button type="submit" disabled={busy} className={`button ${modal.type === "purge" ? "button-danger" : "button-primary"}`}>{busy && <Loader2 className="spinning" size={16} />}{busy ? "Working…" : modal.type === "share" ? "Create link" : modal.type === "purge" ? "Delete permanently" : modal.type === "trash" ? "Move to trash" : "Save"}</button></div>
      </form>}
      {modal.type === "share" && <>{linkUrl && <div className="created-link"><label className="field-label">Your new link<input className="text-input" value={linkUrl} readOnly onFocus={(event) => event.target.select()} /></label><button className="button button-quiet" onClick={() => void copyLink()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "Copied" : "Copy link"}</button></div>}<div className="share-history"><h3>Manage links</h3><p className="helper">Existing secret URLs cannot be recovered. Create a new one if needed. Revocation blocks new downloads; an issued transfer URL may work for up to 5 minutes.</p>{linksLoading ? <p>Loading links…</p> : !links.length ? <p className="muted">No links yet.</p> : links.map((link) => { const inactive = !!link.revokedAt || new Date(link.expiresAt).getTime() <= linkCheckTime; return <div className="share-history-row" key={link.id}><div><strong>{link.revokedAt ? "Revoked" : inactive ? "Expired" : link.passwordProtected ? "Password protected" : "Anyone with link"}</strong><span>Expires {formatDate(link.expiresAt)}</span></div>{!inactive && <button className="button button-quiet danger-text" disabled={busy} onClick={() => void mutate(async () => { await api(`/api/share-links/${link.id}`, "DELETE"); setLinkUrl(""); await refreshLinks(modal.file); }, "Link revoked.", true)}>Revoke</button>}</div>; })}</div></>}
      </div>}
    </dialog>{preview && <FilePreview file={preview} storageId={storage.id} onClose={() => setPreview(null)} />}
  </main>;
}
function message(error: unknown) { return error instanceof Error ? error.message : "Something went wrong. Please retry."; }
function formatBytes(bytes: number) { if (!bytes) return "0 B"; const units = ["B", "KB", "MB", "GB", "TB"]; const index = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1000))); return `${Number((bytes / 1000 ** index).toFixed(1))} ${units[index]}`; }
function formatDate(value: string) { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)); }
