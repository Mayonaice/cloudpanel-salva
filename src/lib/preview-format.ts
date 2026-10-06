export type PreviewFile = { id: string; name: string; contentType: string; sizeBytes: number };
export const fileExtension = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
export const canPreview = (file: Pick<PreviewFile, "name">) => ["mp4", "mkv", "png", "jpg", "jpeg", "pdf", "docx", "xlsx", "xls", "csv"].includes(fileExtension(file.name));
export const previewMime = (name: string) => ({ mp4: "video/mp4", mkv: "video/mp4", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel", csv: "text/csv" }[fileExtension(name)] ?? "application/octet-stream");
