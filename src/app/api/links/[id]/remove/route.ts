/** POST /api/links/:id/remove { reason? } */
import { mutateById } from "@/app/api/_lib/route";
import { removeLink } from "@/server/services/links";

export const POST = mutateById("linkId", removeLink);
