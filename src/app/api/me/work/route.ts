/** GET /api/me/work -> MyWorkQueue */
import { read } from "@/app/api/_lib/route";
import { getMyWorkQueue } from "@/server/queries/myWork";

export const GET = read((db, ctx) => getMyWorkQueue(db, ctx));
