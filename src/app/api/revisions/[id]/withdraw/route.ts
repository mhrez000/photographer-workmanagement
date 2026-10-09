/** POST /api/revisions/:id/withdraw { expectedVersion (JOB version), reason? } */
import { mutateById } from "@/app/api/_lib/route";
import { withdrawRevision } from "@/server/services/revisions";

export const POST = mutateById("revisionId", withdrawRevision);
