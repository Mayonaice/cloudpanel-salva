import { getEnv } from "@/lib/env";
import { handleRoute, jsonResponse } from "@/lib/http";
import { HttpError } from "@/lib/security";
import { isCronAuthorized, parseJobRunOptions, runJobs } from "@/lib/jobs-runner";
import { enqueueMaintenanceJobs } from "@/lib/jobs";


export const runtime = "nodejs";
export const maxDuration = 60;

async function run(request: Request) {
  if (!isCronAuthorized(request, getEnv().CRON_SECRET)) {
    throw new HttpError(401, "Unauthorized", "cron_unauthorized");
  }
  await enqueueMaintenanceJobs();
  return jsonResponse(await runJobs(parseJobRunOptions(request)));
}

export async function GET(request: Request) {
  return handleRoute(() => run(request));
}

export async function POST(request: Request) {
  return handleRoute(() => run(request));
}
