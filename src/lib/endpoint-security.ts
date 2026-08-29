import { lookup } from "node:dns";
import { Agent } from "node:https";
import ipaddr from "ipaddr.js";
import { HttpError } from "./security";

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}
export function validateEndpoint(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new HttpError(400, "Endpoint must be a valid HTTPS URL", "invalid_endpoint"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443") || url.pathname !== "/") throw new HttpError(400, "Use a public HTTPS origin without a path, credentials, or custom port", "invalid_endpoint");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || (ipaddr.isValid(host) && !isPublicAddress(host))) throw new HttpError(400, "Private network endpoints are not allowed; use a public tunnel hostname", "private_endpoint");
  return url.origin;
}

// Validate every DNS answer at actual socket creation, not just at form save.
// This closes the DNS-rebinding gap while preserving TLS hostname verification.
export function publicHttpsAgent() {
  return new Agent({ keepAlive: false, lookup(hostname, options, callback) {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error, [], 4);
      if (!addresses.length || addresses.some((item) => ! isPublicAddress(item.address))) return callback(new Error("Blocked private endpoint resolution"), [], 4);
      if (typeof options === "object" && options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  } });
}
