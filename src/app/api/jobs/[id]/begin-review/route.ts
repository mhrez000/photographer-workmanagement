/** POST /api/jobs/:id/begin-review { expectedVersion, toStatusId?, reason? } - submitted / resubmitted -> review */
import { mutateById } from "@/app/api/_lib/route";
import { beginReview } from "@/server/services/workflow";

export const POST = mutateById("jobId", beginReview);
