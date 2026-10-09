/** PATCH /api/revisions/:id { assigneeUserId?, instructions?, priority?, dueDate? } (open revisions only) */
import { mutateById } from "@/app/api/_lib/route";
import { updateRevision } from "@/server/services/revisions";

export const PATCH = mutateById("revisionId", updateRevision);
