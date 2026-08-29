"use client";
import { useState } from "react";
import { KeyRound, Loader2, X } from "lucide-react";
export default function GuestLogin() {
  const [open,setOpen]=useState(false),[key,setKey]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  async function login(e: React.FormEvent){e.preventDefault();setBusy(true);setError("");try{const r=await fetch("/api/auth/guest",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key})});const b=await r.json();if(!r.ok)throw new Error(b.message??"Login failed");location.reload()}catch(e){setError(e instanceof Error?e.message:"Login failed")}finally{setBusy(false)}}
  return <>{<button className="guest-login-button" onClick={()=>setOpen(true)}><KeyRound size={17}/>Login with key</button>}{open&&<div className="guest-login-panel"><div><strong>Guest access</strong><button className="icon-button" aria-label="Close key login" onClick={()=>setOpen(false)}><X size={17}/></button></div><p>Paste the private key issued by the workspace owner.</p><form onSubmit={login}><input className="text-input" type="password" value={key} onChange={e=>setKey(e.target.value)} autoComplete="off" required minLength={70} placeholder="salva_guest_…"/><button className="button button-primary" disabled={busy}>{busy&&<Loader2 className="spinning" size={15}/>}Open workspace</button></form>{error&&<p className="form-error" role="alert">{error}</p>}</div>}</>;
}
