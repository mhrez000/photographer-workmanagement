import { redirect } from "next/navigation";
import { allowed, pageContext } from "@/server/page";

/** /settings → Studio for admins, My account for everyone else (plan §3). */
export default async function SettingsIndexPage() {
  const { ctx } = await pageContext();
  redirect(allowed(ctx, "settings.view") ? "/settings/studio" : "/settings/account");
}
