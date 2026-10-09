/** POST /api/links/:id/replace { url, label? } -> { link, previous } */
import { mutateById } from "@/app/api/_lib/route";
import { replaceLink } from "@/server/services/links";

export const POST = mutateById("linkId", replaceLink);
