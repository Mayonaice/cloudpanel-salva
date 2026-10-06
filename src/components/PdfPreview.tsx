"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";

export default function PdfPreview({ source, name }: { source: string; name: string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [page, setPage] = useState(1), [error, setError] = useState(""), [rendering, setRendering] = useState(true), [width, setWidth] = useState(800);
  const canvas = useRef<HTMLCanvasElement>(null), container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false, loading: PDFDocumentLoadingTask | undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const library = await import("pdfjs-dist");
        if (cancelled) return;
        library.GlobalWorkerOptions.workerSrc = "/workers/pdf.worker.min.mjs";
        const response = await fetch(`${source}${source.includes("?") ? "&" : "?"}encoding=base64`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message ?? "Could not load PDF preview"); }
        const binary = atob(await response.text());
        const data = Uint8Array.from(binary, character => character.charCodeAt(0));
        if (cancelled) return;
        loading = library.getDocument({ data, disableFontFace: true, cMapUrl: "/workers/pdf-cmaps/", cMapPacked: true, standardFontDataUrl: "/workers/pdf-fonts/", wasmUrl: "/workers/pdf-wasm/" });
        const document = await loading.promise;
        if (!cancelled) setPdf(document);
      } catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : "Could not open PDF preview"); }
    })();
    return () => { cancelled = true; controller.abort(); void loading?.destroy(); };
  }, [source]);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(200, Math.min(1000, entries[0].contentRect.width - 36))));
    observer.observe(container.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let cancelled = false, task: RenderTask | undefined;
    const target = canvas.current;
    void (async () => {
      try {
        const documentPage = await pdf.getPage(page);
        if (cancelled) return;
        const viewport = documentPage.getViewport({ scale: width / documentPage.getViewport({ scale: 1 }).width });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        target.width = Math.ceil(viewport.width * ratio); target.height = Math.ceil(viewport.height * ratio);
        const context = target.getContext("2d"); if (!context) throw new Error("PDF canvas is unavailable");
        task = documentPage.render({ canvas: target, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
        await task.promise;
        if (!cancelled) setRendering(false);
      } catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : "Could not render this PDF page"); }
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [pdf, page, width]);
  return <div className="pdf-preview" ref={container}>{error ? <p className="preview-state preview-error" role="alert">{error}</p> : <><nav className="pdf-toolbar" aria-label="PDF pages"><button className="icon-button" aria-label="Previous PDF page" disabled={!pdf || page <= 1 || rendering} onClick={() => { setRendering(true); setPage(current => current - 1); }}><ArrowLeft size={17} /></button><span>Page {page} of {pdf?.numPages ?? "…"}</span><button className="icon-button" aria-label="Next PDF page" disabled={!pdf || page >= pdf.numPages || rendering} onClick={() => { setRendering(true); setPage(current => current + 1); }}><ArrowRight size={17} /></button></nav>{(!pdf || rendering) && <div className="preview-state pdf-loading"><Loader2 size={18} className="spinning" />Rendering PDF…</div>}<canvas ref={canvas} role="img" aria-label={`${name}, page ${page}`} /></>}</div>;
}
