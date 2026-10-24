import type { AccountBannerState } from "@/lib/types";
import { DemoStudioBanner } from "./demo-studio-banner";
import { UnconfirmedEmailBanner } from "./unconfirmed-email-banner";

/**
 * The quiet banners above every signed-in page (docs/ACCOUNTS-PLAN.md §6) — the staff shell (`AppShell banner`)
 * and the client portal. FOUNDATION-owned: decides WHICH banner shows (`accountBannerState`); the banners
 * themselves belong to AREA access (demo) and AREA verify (confirm your email).
 */
export function AccountBanners({ state }: { state: AccountBannerState }) {
  if (state.demo) return <DemoStudioBanner surface={state.surface} />;
  if (state.unconfirmedEmail) return <UnconfirmedEmailBanner email={state.unconfirmedEmail} accountHref={state.accountHref} />;
  return null;
}
