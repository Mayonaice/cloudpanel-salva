"use client";

import Logo from "@/components/Logo";
import { useEffect, useState } from "react";
import { Download, LockKeyhole } from "lucide-react";

export default function ShareClient({ token }: { token: string }) {
  const [data, setData] = useState<{ requiresPassword?: boolean; name?: string; url?: string; expiresAt?: string } | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  async function download() {
    if (unlocking) return;
    setUnlocking(true); setError(null);
    try {
      const response = await fetch(`/api/shares/${encodeURIComponent(token)}`, password ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) } : { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.url) throw new Error(payload.message ?? "This share is no longer available");
      window.location.assign(payload.url);
    } catch (error) { setError(error instanceof Error ? error.message : "Download failed"); }
    finally { setUnlocking(false); }
  }
  useEffect(() => { fetch(`/api/shares/${encodeURIComponent(token)}`).then(async (response) => { const payload = await response.json(); if (!response.ok) setError(payload.message ?? "This share is unavailable"); else setData(payload); }).catch(() => setError("This share is unavailable")); }, [token]);
  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    if (unlocking) return;
    setUnlocking(true);
    setError(null);
    try {
      const response = await fetch(`/api/shares/${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      const payload = await response.json();
      if (!response.ok) setError(payload.message ?? "Incorrect password");
      else setData(payload);
    } catch {
      setError("Connection failed. Please try again.");
    } finally { setUnlocking(false); }
  }
  return <main className="share-shell"><div className="share-card"><div className="brand-symbol"><Logo size={48} /></div>{error && !data ? <><p className="eyebrow">LINK UNAVAILABLE</p><h1>Nothing to see<br /><em>here.</em></h1><p className="auth-copy">This link may have expired, been revoked, or the file may have moved to trash.</p></> : !data ? <p className="loading-copy">Checking secure link…</p> : data.url ? <><p className="eyebrow">PRIVATE SHARE</p><h1>{data.name}</h1><p className="auth-copy">This file is ready for download. The transfer URL is short-lived and generated only when requested.</p><button className="button button-primary button-wide" disabled={unlocking} onClick={() => void download()}><Download size={17} />{unlocking ? "Preparing…" : "Download file"}</button>{error && <p className="form-error" role="alert">{error}</p>}</> : <><p className="eyebrow">PASSWORD REQUIRED</p><h1>A little<br /><em>privacy check.</em></h1><p className="auth-copy">Enter the password set by the owner to unlock this file.</p><form onSubmit={unlock}>{error && <p role="alert">{error}</p>}<label className="password-field"><LockKeyhole size={16} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} aria-label="Share password" placeholder="Share password" autoFocus /></label><button className="button button-primary button-wide" type="submit" disabled={unlocking}>Unlock file <span aria-hidden="true">↗</span></button></form></>}</div></main>;
}
