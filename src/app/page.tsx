import { redirect } from "next/navigation";
import { getOptionalContext } from "@/server/auth/session";

/** Landing by persona (docs/ROLES.md §7.8): clients → /portal, staff → /dashboard. */
export default async function Home() {
  const ctx = await getOptionalContext();
  redirect(ctx?.role === "client" ? "/portal" : "/dashboard");
}
