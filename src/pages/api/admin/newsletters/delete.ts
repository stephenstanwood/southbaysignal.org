/**
 * Delete a newsletter target from the tracker.
 *
 * DELETE /api/admin/newsletters/delete?id=<target-id>&key=<ADMIN_KEY>
 *
 * Also accepts POST for easier fetch-from-browser. Auth via ?key= query
 * param matching ADMIN_KEY env var (same as the admin page).
 */

import type { APIRoute } from "astro";
import { readTracker, markDeleted } from "../../../../lib/lookout/tracker.ts";

export const prerender = false;

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const expected = process.env.ADMIN_KEY ?? "";
  const provided = url.searchParams.get("key") ?? "";
  if (!expected || provided !== expected) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const id = url.searchParams.get("id") ?? "";
  if (!id) {
    return Response.json({ ok: false, error: "missing id" }, { status: 400 });
  }

  const doc = await readTracker();
  const existed = doc.targets.some((t) => t.id === id);
  // Always persist to the deletedIds blocklist, even if the row was already gone,
  // so subscribe scripts won't re-add it on re-seed.
  await markDeleted(id);
  if (!existed) {
    return Response.json({ ok: true, deleted: id, alreadyGone: true });
  }
  const after = await readTracker();
  return Response.json({ ok: true, deleted: id, remaining: after.targets.length });
}

export const POST: APIRoute = ({ request }) => handle(request);
export const DELETE: APIRoute = ({ request }) => handle(request);
