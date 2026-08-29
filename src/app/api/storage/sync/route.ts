import { handleStorageRoute } from "@/lib/storage-route";
import { requireSession } from "@/lib/auth";
import { syncBucket } from "@/lib/bucket-sync";

import { assertSameOrigin, jsonResponse } from "@/lib/security";
import { requireStorageReady } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = (request: Request) => handleStorageRoute(request, async () => {
  assertSameOrigin(request);
  const session = await requireSession();
  requireStorageReady();
  return jsonResponse(await syncBucket(session.userId));
});
