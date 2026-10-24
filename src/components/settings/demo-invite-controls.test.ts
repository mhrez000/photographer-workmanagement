/**
 * Invite controls in the demo studio (docs/ACCOUNTS.md §7), rendered to static HTML: the services refuse invites and
 * password resets there (403), so the screens don't offer them and say why — the person page's Invite card and a
 * client's Online access. Outside the demo nothing changes.
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ClientPortalAccess } from "@/lib/sharing";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/clients/c1",
  useSearchParams: () => new URLSearchParams(),
}));

const { InviteStatusCard } = await import("./invite-status-card");
const { ClientOnlineAccess } = await import("@/components/production/client-online-access");
const { DEMO_BLOCKED_MESSAGES } = await import("@/server/auth/demo");
const { UserLifecycleCard } = await import("./user-lifecycle");

const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const TZ = "Australia/Sydney";

describe("InviteStatusCard", () => {
  const base = { userId: "u1", name: "Sam Invitee", email: "sam@studio.test", timeZone: TZ };

  it("demo studio: no Send / Revoke buttons, and the plain reason instead of 'only an owner'", () => {
    const html = renderToStaticMarkup(
      React.createElement(InviteStatusCard, { ...base, pending: null, canInvite: false, blockedReason: `${DEMO_BLOCKED_MESSAGES.invite}.` }),
    );
    expect(textOf(html)).toContain("Invites are turned off in the demo studio.");
    expect(textOf(html)).not.toContain("Only an owner can send a new link.");
    expect(textOf(html)).not.toContain("Send a new link");
    expect(textOf(html)).not.toContain("Revoke invite");
  });

  it("an ordinary studio without the right to invite keeps 'Only an owner can send a new link.'", () => {
    const html = renderToStaticMarkup(React.createElement(InviteStatusCard, { ...base, pending: null, canInvite: false }));
    expect(textOf(html)).toContain("Only an owner can send a new link.");
  });

  it("an owner sees Send a new link / Revoke invite", () => {
    const html = renderToStaticMarkup(React.createElement(InviteStatusCard, { ...base, pending: { expiresAt: "2026-10-31T00:00:00.000Z" }, canInvite: true }));
    expect(textOf(html)).toContain("Send a new link");
    expect(textOf(html)).toContain("Revoke invite");
  });
});

describe("ClientOnlineAccess", () => {
  const access: ClientPortalAccess = {
    clientId: "c1",
    clientName: "Harbourline Realty",
    version: 1,
    portalEnabled: true,
    feedbackEnabled: true,
    archived: false,
    users: [{ id: "u9", name: "Bea Buyer", email: "bea@harbour.test", isActive: true, lastLoginAt: null, version: 1 }],
    sharedProjectCount: 0,
    sharedJobCount: 2,
  };

  it("demo studio: the Invite button is disabled and says why", () => {
    const html = renderToStaticMarkup(
      React.createElement(ClientOnlineAccess, { access, studioName: "Northlight Studios", timeZone: TZ, invites: { u9: { live: null } }, demo: true }),
    );
    expect(html).toContain("data-demo-invites-off");
    expect(textOf(html)).toContain("Invites are turned off in the demo studio.");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^]*?Invite/);
  });

  it("an ordinary studio: no demo note, the Invite button works", () => {
    const html = renderToStaticMarkup(React.createElement(ClientOnlineAccess, { access, studioName: "Your Studio", timeZone: TZ }));
    expect(html).not.toContain("data-demo-invites-off");
    expect(textOf(html)).not.toContain("turned off in the demo studio");
  });
});

describe("the demo's Client persona (SEC-07 / DEMO-01 / DEMO-03)", () => {
  const personaAccess: ClientPortalAccess = {
    clientId: "c-harbour",
    clientName: "Harbourline Realty",
    version: 3,
    portalEnabled: true,
    feedbackEnabled: true,
    archived: false,
    users: [
      { id: "u-client", name: "Sarah Kingsley", email: "client@studio.test", isActive: true, lastLoginAt: null, version: 1 },
      { id: "u-other", name: "Bea Buyer", email: "bea@harbour.test", isActive: true, lastLoginAt: null, version: 1 },
    ],
    sharedProjectCount: 0,
    sharedJobCount: 2,
  };

  it("demo studio: the online-access switch is locked on with plain words, and the persona row offers no actions", () => {
    const html = renderToStaticMarkup(React.createElement(ClientOnlineAccess, { access: personaAccess, studioName: "Northlight Studios", timeZone: TZ, demo: true }));
    expect(html).toContain("data-demo-locked");
    expect(textOf(html)).toContain("Stays on in the demo studio: it is how visitors look around as the client.");
    expect(html).toContain("data-demo-persona-row");
    expect(textOf(html)).toContain("Demo account");
    // Only the non-persona person keeps an actions menu.
    expect(html).not.toContain('aria-label="Actions for Sarah Kingsley"');
    expect(html).toContain('aria-label="Actions for Bea Buyer"');
  });

  it("outside the demo the same client is an ordinary client (switch free, every row has its menu)", () => {
    const html = renderToStaticMarkup(React.createElement(ClientOnlineAccess, { access: personaAccess, studioName: "Your Studio", timeZone: TZ }));
    expect(html).not.toContain("data-demo-locked");
    expect(html).not.toContain("data-demo-persona-row");
    expect(html).toContain('aria-label="Actions for Sarah Kingsley"');
  });
});

describe("a demo persona's person page (DEMO-07)", () => {
  it("the Account card carries the locked reason instead of standing empty", () => {
    const profile = { id: "u1", name: "Priya Nair", email: "photographer01@studio.test", role: "photographer", isActive: true, anonymisedAt: null, version: 1 } as never;
    const html = renderToStaticMarkup(
      React.createElement(UserLifecycleCard, {
        profile,
        access: { resetPassword: false, deactivate: false, reactivate: true, anonymise: false, lockedReason: DEMO_BLOCKED_MESSAGES.demo_accounts },
        isSelf: false,
        editorJobs: [],
        photographerJobs: [],
        timeZone: TZ,
      }),
    );
    expect(textOf(html).replace(/&#x27;/g, "'")).toContain(DEMO_BLOCKED_MESSAGES.demo_accounts);
    expect(textOf(html)).not.toContain("Password, access and what happens to their jobs.");
  });
});
