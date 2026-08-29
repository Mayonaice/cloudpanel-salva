import { requireSession, requireStorageAdmin } from "@/lib/auth";
import { createConnection, createConnectionSchema, listConnections } from "@/lib/storage-connections";
import { handleRoute, readJson } from "@/lib/http";
import { assertSameOrigin, jsonResponse } from "@/lib/security";
import { parseOrBad } from "@/lib/validation";

export const GET = (request: Request) => handleRoute(async () => { assertSameOrigin(request); return jsonResponse({ connections: await listConnections((await requireSession()).userId) }); });
export const POST = (request: Request) => handleRoute(async () => { assertSameOrigin(request); const owner = await requireStorageAdmin(); return jsonResponse({ connection: await createConnection(owner.userId, parseOrBad(createConnectionSchema, await readJson(request))) }, { status: 201 }); });
