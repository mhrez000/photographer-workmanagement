/**
 * The "Confirm your email" UI pieces (AREA verify), rendered to static HTML: the banner shows ONLY when email is
 * configured, the studio is not the demo and the address is unconfirmed (`accountBannerState` with an injected env —
 * the configured case the e2e server cannot show), the Email card's status chip, the invite panel's copy for an
 * unconfirmed inviter, and the plain-words outcomes of "Send again".
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AccountSecurityOverview } from "@/lib/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/home",
  useSearchParams: () => new URLSearchParams(),
}));

const { AccountBanners } = await import("./account-banners");
const { EmailConfirmationStatus } = await import("./email-confirmation-status");
const { UnconfirmedEmailBanner } = await import("./unconfirmed-email-banner");
const { outcomeOfError, outcomeOfResult } = await import("./resend-email-confirmation");
const { InviteLinkPanel, UNCONFIRMED_SENDER_MESSAGE } = await import("@/components/settings/invite-link-panel");
const { accountBannerState } = await import("@/server/queries/accountSecurity");
const { ApiError } = await import("@/lib/api-client");

const CONFIGURED = { RESEND_API_KEY: "re_test", EMAIL_FROM: "Proofline <hello@example.com>" };
const NOT_CONFIGURED = {};

const render = (node: React.ReactElement) => renderToStaticMarkup(node);
/** Visible text only (tags stripped, entities for the curly quotes kept as characters). */
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function viewer(over: Partial<{ role: "photographer" | "editor" | "client"; email: string; isDemo: boolean; emailVerifiedAt: string | null }> = {}) {
  return { role: "photographer" as const, email: "mo@northlight.test", isDemo: false, emailVerifiedAt: null, ...over };
}

describe("UnconfirmedEmailBanner via AccountBanners", () => {
  it("configured + unconfirmed: the quiet banner with Send again and Change email (→ the account's email card)", () => {
    const html = render(React.createElement(AccountBanners, { state: accountBannerState(viewer(), CONFIGURED) }));
    expect(textOf(html)).toContain("Please confirm your email. We sent a link to mo@northlight.test .");
    expect(html).toContain("data-unconfirmed-email-banner");
    expect(html).toMatch(/<button[^>]*data-resend-confirmation[^>]*>/);
    expect(textOf(html)).toContain("Send again");
    expect(html).toContain('href="/settings/account#email"');
    expect(textOf(html)).toContain("Change email");
    expect(html).toContain('aria-label="Confirm your email"');
  });

  it("clients: Change email goes to the portal's account page", () => {
    const html = render(React.createElement(AccountBanners, { state: accountBannerState(viewer({ role: "client" }), CONFIGURED) }));
    expect(html).toContain('href="/portal/account#email"');
  });

  it("hidden when email is not configured, when confirmed, and in the demo studio", () => {
    expect(render(React.createElement(AccountBanners, { state: accountBannerState(viewer(), NOT_CONFIGURED) }))).toBe("");
    expect(render(React.createElement(AccountBanners, { state: accountBannerState(viewer({ emailVerifiedAt: "2026-10-08T00:00:00.000Z" }), CONFIGURED) }))).toBe("");
    expect(render(React.createElement(AccountBanners, { state: accountBannerState(viewer({ isDemo: true }), CONFIGURED) }))).not.toContain("Please confirm your email");
  });

  it("long addresses wrap instead of overflowing a phone screen", () => {
    const html = render(React.createElement(UnconfirmedEmailBanner, { email: "a-very-long-address-for-a-small-screen@an-equally-long-studio-domain.example", accountHref: "/settings/account#email" }));
    expect(html).toContain("break-all");
  });
});

function overview(over: Partial<AccountSecurityOverview> = {}): AccountSecurityOverview {
  return {
    userId: "u1",
    name: "Mo",
    email: "mo@northlight.test",
    emailVerifiedAt: null,
    emailConfigured: true,
    isDemo: false,
    hasPassword: true,
    google: { configured: false, connected: false, email: null },
    pendingEmailChange: null,
    surface: "staff",
    accountPath: "/settings/account",
    timezone: "Australia/Sydney",
    ...over,
  };
}

describe("EmailConfirmationStatus", () => {
  it("unconfirmed: 'Not confirmed yet · Send again'", () => {
    const html = render(React.createElement(EmailConfirmationStatus, { overview: overview() }));
    expect(html).toContain('data-email-confirmation="unconfirmed"');
    expect(textOf(html)).toContain("Not confirmed yet");
    expect(textOf(html)).toContain("Send again");
  });

  it("confirmed: a 'Confirmed' chip", () => {
    const html = render(React.createElement(EmailConfirmationStatus, { overview: overview({ emailVerifiedAt: "2026-10-08T00:00:00.000Z" }) }));
    expect(html).toContain('data-email-confirmation="confirmed"');
    expect(textOf(html)).toBe("Confirmed");
  });

  it("nothing without a mail provider or in the demo studio", () => {
    expect(render(React.createElement(EmailConfirmationStatus, { overview: overview({ emailConfigured: false }) }))).toBe("");
    expect(render(React.createElement(EmailConfirmationStatus, { overview: overview({ isDemo: true }) }))).toBe("");
  });
});

describe("InviteLinkPanel", () => {
  const base = { name: "Sam Editor", email: "sam@studio.test", inviteUrl: "http://localhost:3130/invite/abc", expiresAt: "2026-10-15T00:00:00.000Z", timeZone: "Australia/Sydney" };

  it("an unconfirmed inviter: says why nothing was emailed, above the link", () => {
    const html = render(React.createElement(InviteLinkPanel, { ...base, emailed: false, notSentReason: "unconfirmed_sender" }));
    const text = textOf(html);
    expect(text).toContain(UNCONFIRMED_SENDER_MESSAGE);
    expect(html).toContain('data-invite-not-sent-reason="unconfirmed_sender"');
    expect(text.indexOf("isn’t confirmed yet")).toBeLessThan(text.indexOf("http://localhost:3130/invite/abc"));
    expect(text).not.toContain("Nothing was emailed");
  });

  it("no provider / unknown reason: the generic line; a provider failure says the email didn't go through", () => {
    expect(textOf(render(React.createElement(InviteLinkPanel, { ...base, emailed: false })))).toContain("Nothing was emailed. Send sam@studio.test this link yourself");
    expect(textOf(render(React.createElement(InviteLinkPanel, { ...base, emailed: false, notSentReason: "not_configured" })))).toContain("Nothing was emailed.");
    expect(textOf(render(React.createElement(InviteLinkPanel, { ...base, emailed: false, notSentReason: "failed" })))).toContain("The email didn’t go through");
  });

  it("emailed: unchanged", () => {
    const text = textOf(render(React.createElement(InviteLinkPanel, { ...base, emailed: true, notSentReason: null })));
    expect(text).toContain("We emailed sam@studio.test");
    expect(text).not.toContain("isn’t confirmed yet");
  });
});

describe("Send again outcomes", () => {
  it("maps API results to plain outcomes", () => {
    expect(outcomeOfResult({ sent: true, reason: null })).toEqual({ kind: "sent" });
    expect(outcomeOfResult({ sent: false, reason: "not_configured", devLink: "http://localhost/verify-email?token=x" })).toEqual({ kind: "dev_link", url: "http://localhost/verify-email?token=x" });
    expect(outcomeOfResult({ sent: false, reason: "already_confirmed" })).toEqual({ kind: "already_confirmed" });
    expect(outcomeOfResult({ sent: false, reason: "failed" })).toMatchObject({ kind: "failed" });
    expect(outcomeOfResult({ sent: false, reason: "demo" })).toMatchObject({ kind: "failed" });
  });

  it("maps errors: 429 → the wait in minutes, 422 → already confirmed, 401 → sign in again", () => {
    expect(outcomeOfError(new ApiError(429, "rate_limited", "Too many attempts", { retryAfterSeconds: 1500 }))).toEqual({ kind: "rate_limited", wait: "25 minutes" });
    expect(outcomeOfError(new ApiError(429, "rate_limited", "Too many attempts", { retryAfterSeconds: 20 }))).toEqual({ kind: "rate_limited", wait: "a minute" });
    expect(outcomeOfError(new ApiError(422, "validation", "Your email is already confirmed"))).toEqual({ kind: "already_confirmed" });
    expect(outcomeOfError(new ApiError(401, "unauthorized", "Sign in required"))).toMatchObject({ kind: "failed", message: expect.stringContaining("logged out") });
    expect(outcomeOfError(new Error("boom"))).toMatchObject({ kind: "failed" });
  });
});
