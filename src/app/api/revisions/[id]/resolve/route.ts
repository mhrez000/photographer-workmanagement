/** POST /api/revisions/:id/resolve { expectedVersion (JOB version), note?, toStatusId? } (= -> resubmitted) */
import { mutateById } from "@/app/api/_lib/route";
import { resolveRevision } from "@/server/services/revisions";

export const POST = mutateById("revisionId", resolveRevision);
