/**
 * The Google card on My account (SEC-03), rendered to static HTML: "Connect Google" is a button that asks for the
 * password first (no link straight to Google any more); without a password there is nothing to check, so it says to
 * set one first.
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/settings/account",
  useSearchParams: () => new URLSearchParams(),
}));

const { GoogleSignInControls } = await import("./google-sign-in-controls");

const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("Connect Google (SEC-03)", () => {
  it("with a password: a button (the password step opens on press), never a link to /api/auth/google/start", () => {
    const html = renderToStaticMarkup(React.createElement(GoogleSignInControls, { configured: true, connected: false, googleEmail: null, hasPassword: true }));
    expect(html).toContain("data-connect-google");
    expect(html).not.toContain("/api/auth/google/start");
    expect(html).not.toMatch(/<a[^>]*data-google-button/);
    expect(textOf(html)).toContain("Connect Google");
  });

  it("without a password: set one first", () => {
    const html = renderToStaticMarkup(React.createElement(GoogleSignInControls, { configured: true, connected: false, googleEmail: null, hasPassword: false }));
    expect(html).not.toContain("data-connect-google");
    expect(textOf(html)).toContain("Set a password above first, then you can connect Google.");
  });
});
