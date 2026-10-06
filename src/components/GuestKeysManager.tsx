"use client";
import { useEffect, useState } from "react";
import Select from "./Select";
import { Check, Copy, KeyRound, ShieldCheck, Trash2 } from "lucide-react";

type KeyRecord = { id: string; name: string; role: "admin" | "full" | "readonly"; createdAt: string; lastUsedAt: string | null };

export default function GuestKeysManager({ canManage }: { canManage: boolean }) {
  const [keys, setKeys] = useState<KeyRecord[]>([]), [name, setName] = useState(""), [role, setRole] = useState<KeyRecord["role"]>("readonly"), [secret, setSecret] = useState(""), [copied, setCopied] = useState(false), [error, setError] = useState("");
  async function load() { const response = await fetch("/api/guest-keys", { cache: "no-store" }), body = await response.json(); if (!response.ok) throw new Error(body.message); setKeys(body.keys); }
  useEffect(() => { const timer = setTimeout(() => void load().catch(error => setError(error.message)), 0); return () => clearTimeout(timer); }, []);
  async function create(event: React.FormEvent) { event.preventDefault(); setError(""); const response = await fetch("/api/guest-keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, role }) }), body = await response.json(); if (!response.ok) return setError(body.message); setSecret(body.key); setName(""); await load(); }
  async function revoke(id: string) { if (!confirm("Revoke this guest key? Existing guest sessions will stop working.")) return; const response = await fetch(`/api/guest-keys/${id}`, { method: "DELETE" }); if (!response.ok) return setError("Could not revoke key"); await load(); }
  return <section className="guest-keys-section">
    <div className="section-heading"><div><p className="eyebrow">ACCESS SECURITY</p><h2>Guest login keys</h2><p>{canManage ? "Create scoped access without sharing your Google account." : "Review guest access issued by this workspace owner."}</p></div><KeyRound size={25} /></div>
    {canManage && <>{secret && <div className="key-reveal"><strong>Copy this key now. It will not be shown again.</strong><code>{secret}</code><button className="button button-primary" onClick={async () => { await navigator.clipboard.writeText(secret); setCopied(true); }}>{copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "Copied" : "Copy key"}</button></div>}<form onSubmit={create} className="guest-key-form"><label className="field-label">Key name<input className="text-input" value={name} onChange={event => setName(event.target.value)} required maxLength={80} placeholder="Family laptop" /></label><label className="field-label">Access role<Select label="Access role" value={role} onChange={value => setRole(value as KeyRecord["role"])} options={[{value:"admin",label:"Admin",description:"Storage, files, and share passwords"},{value:"full",label:"Full Access",description:"Files, folders, and share links"},{value:"readonly",label:"Read Only",description:"View and download"}]} /></label><button className="button button-primary">Generate key</button></form></>}
    {!canManage && <p className="key-admin-note"><ShieldCheck size={16} />Administrators can audit keys. Only the workspace owner can generate or revoke them.</p>}
    {error && <p className="form-error">{error}</p>}
    <div className="guest-key-list">{keys.map(key => <article key={key.id}><span><strong>{key.name}</strong><small>{key.role === "full" ? "Full Access" : key.role} · created {new Date(key.createdAt).toLocaleDateString()} · {key.lastUsedAt ? `last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : "never used"}</small></span>{canManage && <button className="icon-button danger-text" aria-label={`Revoke ${key.name}`} onClick={() => void revoke(key.id)}><Trash2 size={16} /></button>}</article>)}{!keys.length && <p className="muted">No active guest keys.</p>}</div>
  </section>;
}
