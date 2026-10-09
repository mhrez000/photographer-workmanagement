/** GET /api/jobs/:id/links?history=1 -> LinkSlot[]; POST { kind, url, label? } */
import { flag, mutateById, readBy } from "@/app/api/_lib/route";
import { addLink, listLinks } from "@/server/services/links";

export const GET = readBy((db, ctx, id, q) => listLinks(db, ctx, id, { history: flag(q, "history") }));
export const POST = mutateById("jobId", addLink);
