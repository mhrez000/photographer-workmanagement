import { redirect } from "next/navigation";
import { pageContext } from "@/server/page";
import { getUserDetail } from "@/server/queries/users";

/**
 * The second person page is gone (docs/SIMPLIFICATION-PLAN.md §8): an editor's old link opens their
 * Editors page; anyone else's opens Settings → People. Server-side twin of the `next.config.ts` redirect.
 */
export default async function LegacyPersonPage({ params }: PageProps<"/team/users/[id]">) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const { ctx, db } = await pageContext();
  let isEditor = true;
  try {
    isEditor = (await getUserDetail(db, ctx, id)).ref.role === "editor";
  } catch {
    // Unknown or hidden person: fall through to the editor page, which answers with its own 404 / 403.
  }
  redirect(isEditor ? `/editors/${encodeURIComponent(id)}` : "/settings/people");
}
