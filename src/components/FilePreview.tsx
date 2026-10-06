"use client";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import PreviewContent from "./PreviewContent";
import { type PreviewFile } from "@/lib/preview-format";
export { canPreview } from "@/lib/preview-format";
export default function FilePreview({ file, storageId, onClose }: { file: PreviewFile; storageId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="preview-overlay" aria-label={`Preview ${file.name}`} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="preview-shell"><header><div><small>FILE PREVIEW</small><strong>{file.name}</strong></div><button className="icon-button" onClick={onClose} aria-label="Close preview"><X size={20} /></button></header><main><PreviewContent key={file.id} file={file} source={`/api/files/${file.id}/preview?storageId=${encodeURIComponent(storageId)}`} /></main></div></dialog>;
}
