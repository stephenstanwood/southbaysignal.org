/**
 * Mark a target with a new status (used by the admin tracker's one-click
 * "Open & Post" action).
 *
 * POST /api/admin/newsletters/mark?id=<id>&status=<status>&key=<ADMIN_KEY>
 *
 * Valid statuses: signup-posted | confirmed | receiving | needs-manual |
 *                 blocked | not-attempted
 */

import type { APIRoute } from "astro";
import { readTracker, writeTracker, writeAuditEntry } from "../../../../lib/lookout/tracker.ts";
import type { SubscribeStatus } from "../../../../lib/lookout/tracker.ts";

export const prerender = false;

const VALID: SubscribeStatus[] = [
  "not-attempted",
  "signup-posted",
  "confirmed",
  "receiving",
  "needs-manual",
  "retry",
  "blocked",
  "failed",
];

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const expected = process.env.ADMIN_KEY ?? "";
  const provided = url.searchParams.get("key") ?? "";
  if (!expected || provided !== expected) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const id = url.searchParams.get("id") ?? "";
  const status = url.searchParams.get("status") as SubscribeStatus;
  if (!id) return Response.json({ ok: false, error: "missing id" }, { status: 400 });
  if (!VALID.includes(status)) return Response.json({ ok: false, error: "invalid status" }, { status: 400 });

  const doc = await readTracker();
  const target = doc.targets.find((t) => t.id === id);
  if (!target) return Response.json({ ok: false, error: "not found" }, { status: 404 });

  const fromStatus = target.status;
  const at = new Date().toISOString();
  target.status = status;
  target.attemptedAt = at;
  await writeAuditEntry({ at, action: "status-change", id, fromStatus, toStatus: status });
  await writeTracker(doc);

  return Response.json({ ok: true, id, status });
}

export const POST: APIRoute = ({ request }) => handle(request);
