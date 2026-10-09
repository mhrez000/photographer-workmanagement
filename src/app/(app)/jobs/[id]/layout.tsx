import { notFound } from "next/navigation";
import { load, pageContext } from "@/server/page";
import { getJobRowByNumber, getJobRowsByIds } from "@/server/queries/jobs";

const JOB_NUMBER = /^[A-Za-z]{1,8}-\d{1,8}$/;

/**
 * Visibility gate above the job's loading boundary: a job that does not exist
 * or that the viewer may not see gets a real 404 status (not a streamed 200).
 * The page itself still loads the full detail and re-checks.
 */
export default async function JobLayout({ children, params }: LayoutProps<"/jobs/[id]">) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const { ctx, db } = await pageContext();
  if (JOB_NUMBER.test(id)) load(() => getJobRowByNumber(db, ctx, id));
  else if (getJobRowsByIds(db, ctx, [id]).length === 0) notFound();
  return children;
}
