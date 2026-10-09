/** GET /api/users/options?role&jobId&includeInactive&excludeSelf&q -> UserOption[] */
import { read } from "@/app/api/_lib/route";
import { getUserOptions } from "@/server/queries/options";

export const GET = read((db, ctx, q) => getUserOptions(db, ctx, q));
