import { request } from "node:https";
import { currentStorage } from "./storage-context";
import { publicHttpsAgent } from "./endpoint-security";
import { HttpError } from "./security";
import type { StorageProvider, StoredObjectHead, MultipartPart, StorageObject, SignedTransfer } from "./storage-provider";

export async function nasControl<T = unknown>(operation: string, input: unknown = {}): Promise<T> {
  const { connection, credentials } = currentStorage();
  const body = JSON.stringify({ operation, input });
  return new Promise((resolve, reject) => {
    const agent = publicHttpsAgent();
    const req = request(`${connection.endpoint}/v1/control`, { method: "POST", agent, timeout: 20000, headers: { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = []; let length = 0;
      res.on("data", (chunk: Buffer) => { length += chunk.length; if (length > 2 * 1024 ** 2) { req.destroy(new Error("Storage gateway response too large")); return; } chunks.push(chunk); });
      res.on("end", () => {
        agent.destroy();
        if (res.statusCode !== 200) { reject(new HttpError(res.statusCode === 404 ? 404 : 502, "Storage gateway request failed. Check connection and permissions.", "gateway_error")); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T); } catch { reject(new HttpError(502, "Storage gateway returned an invalid response", "gateway_response_invalid")); }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("Storage gateway request timed out")));
    req.on("error", () => { agent.destroy(); reject(new HttpError(502, "Storage gateway is offline or unreachable", "gateway_offline")); });
    req.end(body);
  });
}

async function sign(operation: string, input: unknown) {
  const result = await nasControl<SignedTransfer>(operation, input);
  const url = new URL(result.url);
  if (url.origin !== currentStorage().connection.endpoint || url.pathname !== "/v1/transfer" || url.username || url.password) throw new HttpError(502, "Storage gateway returned an invalid transfer URL", "gateway_transfer_invalid");
  return result;
}
export class NasStorageProvider implements StorageProvider {
  readonly name = "transfer-gateway";
  readonly capabilities = { presignedPut: true, presignedGet: true, multipart: true, head: true, range: true, delete: true, checksumSha256: false, list: true } as const;
  createPresignedPut(input: { objectKey: string; contentType: string }) { return sign("signPut", input); }
  createPresignedGet(input: { objectKey: string; fileName: string; expiresIn?: number }) { return sign("signGet", input); }
  createMultipart(input: { objectKey: string; contentType: string }) { return nasControl<{ uploadId: string }>("createMultipart", input); }
  createPresignedPart(input: { objectKey: string; uploadId: string; partNumber: number }) { return sign("signPart", input); }
  completeMultipart(input: { objectKey: string; uploadId: string; parts: MultipartPart[] }) { return nasControl<StoredObjectHead>("completeMultipart", input); }
  abortMultipart(input: { objectKey: string; uploadId: string }) { return nasControl<void>("abortMultipart", input); }
  headObject(objectKey: string) { return nasControl<StoredObjectHead>("head", { key: objectKey }); }
  deleteObject(objectKey: string) { return nasControl<void>("delete", { key: objectKey }); }
  listObjects(input: { continuationToken?: string } = {}) { return nasControl<{ objects: StorageObject[]; continuationToken?: string }>("list", input); }
}
