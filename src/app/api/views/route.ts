/** GET /api/views?scope -> SavedViewItem[]; POST { name, scope, config, isShared?, isDefault? } */
import { mutate, read } from "@/app/api/_lib/route";
import { listSavedViews } from "@/server/queries/views";
import { createSavedView } from "@/server/services/savedViews";

export const GET = read((db, ctx, q) => listSavedViews(db, ctx, q));
export const POST = mutate(createSavedView);
