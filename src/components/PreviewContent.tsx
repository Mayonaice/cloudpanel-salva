"use client";
/* eslint-disable @next/next/no-img-element -- Preview original protected files through the authorized stream, without the public image optimizer. */
import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { fileExtension, type PreviewFile } from "@/lib/preview-format";
import PdfPreview from "./PdfPreview";
export default function PreviewContent({ file, source }: { file: PreviewFile; source: string }) {
  const [html, setHtml] = useState<string | null>(null), [sheets, setSheets] = useState<Array<{ name: string; rows: unknown[][] }>>([]), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  const ext = fileExtension(file.name);
  const document = ["docx", "xlsx", "xls", "csv"].includes(ext);
  useEffect(() => {
    if (!document) return;
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(source, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message ?? "Could not load preview"); }
        const data = await response.arrayBuffer();
        if (controller.signal.aborted) return;
        if (ext === "docx") {
          const [{ default: mammoth }, { default: DOMPurify }] = await Promise.all([import("mammoth/mammoth.browser"), import("dompurify")]);
          const result = await mammoth.convertToHtml({ arrayBuffer: data });
          if (!controller.signal.aborted) setHtml(DOMPurify.sanitize(result.value, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input", "button", "iframe"], FORBID_ATTR: ["style"] }));
        } else {
          const XLSX = await import("@e965/xlsx");
          const workbook = XLSX.read(data, { type: "array", cellDates: true, dense: true });
          const parsed = workbook.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, blankrows: false, defval: "" }) as unknown[][] }));
          if (!controller.signal.aborted) setSheets(parsed);
        }
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Preview failed"); }
    })();
    return () => controller.abort();
  }, [document, ext, source, attempt]);
  const retry = () => { setError(""); setAttempt(value => value + 1); };
  if (error) return <div className="preview-state preview-error" role="alert"><p>{error}</p><button className="button button-quiet" onClick={retry}><RefreshCw size={16} />Try preview again</button></div>;
  if (["mp4", "mkv"].includes(ext)) return <div className="video-preview"><video key={`${source}:${attempt}`} src={source} controls playsInline preload="metadata" onError={() => setError("Video preview could not start. The file may be unavailable or use an unsupported codec. Try again, or download the original.")} />{ext === "mkv" && <p className="helper">A browser-compatible preview is streamed as you watch. Download keeps the original MKV.</p>}</div>;
  if (["png", "jpg", "jpeg"].includes(ext)) return <img key={attempt} src={source} alt={file.name} onError={() => setError("Could not load image preview. Try again or download the original.")} />;
  if (ext === "pdf") return <PdfPreview key={attempt} source={source} name={file.name} />;
  if (html !== null) return <article className="docx-preview" dangerouslySetInnerHTML={{ __html: html || "<p>This document is empty.</p>" }} />;
  if (sheets.length) return <div className="sheet-preview">{sheets.map(sheet => <section key={sheet.name}><h3>{sheet.name}</h3>{sheet.rows.length > 5000 && <p className="helper">Showing the first 5,000 rows. Download the file for all rows.</p>}<div className="sheet-scroll"><table><tbody>{sheet.rows.slice(0, 5000).map((row, i) => <tr key={i}>{row.slice(0, 200).map((cell, j) => <td key={j}>{String(cell ?? "")}</td>)}</tr>)}</tbody></table>{!sheet.rows.length && <p className="preview-state">This sheet is empty.</p>}</div></section>)}</div>;
  return <div className="preview-state"><Loader2 className="spinning" size={20} />Preparing preview…</div>;
}
