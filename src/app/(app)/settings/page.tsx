import { redirect } from "next/navigation";
import { allowed, pageContext } from "@/server/page";

/** /settings → the most useful section for the viewer. */
export default async function SettingsIndexPage() {
  const { ctx } = await pageContext();
  redirect(allowed(ctx, "settings.view") ? "/settings/organisation" : "/settings/notifications");
}
