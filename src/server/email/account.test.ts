/**
 * Account emails (src/server/email/account.ts + the four account templates): demo suppression, unconfirmed
 * senders, not configured / failed with the dev-only link, and the plain-words templates.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { users } from "@/db/schema";
import { makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { EMAIL_CHANGE_TTL_HOURS, EMAIL_VERIFY_TTL_HOURS } from "@/lib/constants";
import { accountEmailBlock, sendAccountEmail } from "./account";
import type { EmailMessage, SendEmailResult } from "./index";
import { confirmEmailEmail, confirmNewEmailEmail, emailChangedNoticeEmail, googleConnectedNoticeEmail, passwordChangedNoticeEmail } from "./templates";

const CONFIGURED = { RESEND_API_KEY: "re_test", EMAIL_FROM: "Proofline <hello@example.com>", NODE_ENV: "test" };
const NOT_CONFIGURED = { NODE_ENV: "test" };
const PRODUCTION_NOT_CONFIGURED = { NODE_ENV: "production" };
const LINK = "http://localhost:3130/verify-email?token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const content = confirmEmailEmail({ name: "Mo", confirmUrl: LINK, expiresAt: "2026-10-10T00:00:00.000Z" });

function okSend() {
  return vi.fn<(m: EmailMessage) => Promise<SendEmailResult>>(async () => ({ ok: true, provider: "resend", id: "msg_1" }));
}

describe("sendAccountEmail", () => {
  let db: TestDb;
  let ids: SeedIds;
  beforeEach(async () => {
    db = await makeTestDb();
    ids = await seedMinimalOrg(db);
  });

  it("sends through the provider when configured (recipient defaults to the account's address)", async () => {
    const send = okSend();
    const result = await sendAccountEmail(db, { userId: ids.users.owner, content, link: LINK }, { env: CONFIGURED, send });
    expect(result).toEqual({ sent: true, reason: null });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: ids.emails.owner, subject: content.subject });
    // `to` overrides the recipient (e.g. the NEW address of an email change).
    await sendAccountEmail(db, { userId: ids.users.owner, to: "new@elsewhere.test", content }, { env: CONFIGURED, send });
    expect(send.mock.calls[1][0].to).toBe("new@elsewhere.test");
  });

  it("never sends for a demo studio, configured or not, and hands back no link", async () => {
    const demoDb = await makeTestDb();
    const demo = await seedMinimalOrg(demoDb, { isDemo: true });
    const send = okSend();
    for (const env of [CONFIGURED, NOT_CONFIGURED]) {
      expect(await sendAccountEmail(demoDb, { userId: demo.users.owner, content, link: LINK }, { env, send })).toEqual({ sent: false, reason: "demo" });
    }
    expect(send).not.toHaveBeenCalled();
    expect(await accountEmailBlock(demoDb, { userId: demo.users.owner }, { env: CONFIGURED })).toBe("demo");
  });

  it("not configured: logs through the console provider and returns the link outside production only", async () => {
    const send = vi.fn<(m: EmailMessage) => Promise<SendEmailResult>>(async () => ({ ok: false, provider: "console", error: "email_not_configured" }));
    expect(await sendAccountEmail(db, { userId: ids.users.owner, content, link: LINK }, { env: NOT_CONFIGURED, send })).toEqual({
      sent: false,
      reason: "not_configured",
      devLink: LINK,
    });
    expect(await sendAccountEmail(db, { userId: ids.users.owner, content, link: LINK }, { env: PRODUCTION_NOT_CONFIGURED, send })).toEqual({
      sent: false,
      reason: "not_configured",
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a provider failure is reported (never thrown), with the dev-only link outside production", async () => {
    const send = vi.fn<(m: EmailMessage) => Promise<SendEmailResult>>(async () => ({ ok: false, provider: "resend", error: "boom" }));
    expect(await sendAccountEmail(db, { userId: ids.users.owner, content, link: LINK }, { env: CONFIGURED, send })).toEqual({
      sent: false,
      reason: "failed",
      devLink: LINK,
    });
    expect(await sendAccountEmail(db, { userId: ids.users.owner, content, link: LINK }, { env: { ...CONFIGURED, NODE_ENV: "production" }, send })).toEqual({
      sent: false,
      reason: "failed",
    });
  });

  it("an unconfirmed sender's emails are suppressed (anti-abuse); a confirmed sender's go out", async () => {
    const send = okSend();
    await db.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, ids.users.owner));
    const blocked = await sendAccountEmail(db, { userId: ids.users.editor1, content, link: LINK, senderUserId: ids.users.owner }, { env: CONFIGURED, send });
    expect(blocked).toEqual({ sent: false, reason: "unconfirmed_sender" });
    expect(send).not.toHaveBeenCalled();
    expect(await accountEmailBlock(db, { userId: ids.users.editor1, senderUserId: ids.users.owner }, { env: CONFIGURED })).toBe("unconfirmed_sender");
    // Not configured wins over the sender rule (nothing could be sent anyway).
    expect(await accountEmailBlock(db, { userId: ids.users.editor1, senderUserId: ids.users.owner }, { env: NOT_CONFIGURED })).toBe("not_configured");
    const ok = await sendAccountEmail(db, { userId: ids.users.editor1, content, senderUserId: ids.users.coAdmin }, { env: CONFIGURED, send });
    expect(ok).toEqual({ sent: true, reason: null });
  });
});

describe("account templates", () => {
  it("confirm your email: subject, the link in text and html, how long it lasts, no 'undefined'", () => {
    expect(content.subject).toBe("Confirm your email for Proofline");
    expect(content.text).toContain(LINK);
    expect(content.html).toContain("Confirm my email");
    expect(content.text).toContain(`${EMAIL_VERIFY_TTL_HOURS} hours`);
    expect(content.text + content.html).not.toMatch(/undefined|null/);
    const withStudio = confirmEmailEmail({ name: "Mo", confirmUrl: LINK, expiresAt: "2026-10-10T00:00:00.000Z", studioName: "Northlight <b>" });
    expect(withStudio.text).toContain("for Northlight <b>");
    expect(withStudio.html).toContain("Northlight &lt;b&gt;");
  });

  it("confirm your new email names the new address and says nothing changes until it is confirmed", () => {
    const c = confirmNewEmailEmail({ name: "Mo", newEmail: "mo@new.test", confirmUrl: LINK, expiresAt: "2026-10-10T00:00:00.000Z" });
    expect(c.subject).toMatch(/new email/i);
    expect(c.text).toContain("mo@new.test");
    expect(c.text).toContain(LINK);
    expect(c.text).toMatch(/Nothing changes until you do/);
    expect(c.text).toContain(`${EMAIL_CHANGE_TTL_HOURS} hours`);
  });

  it("email changed notice: requested vs changed, never a link", () => {
    const requested = emailChangedNoticeEmail({ name: "Mo", newEmail: "mo@new.test", stage: "requested", at: "2026-10-09T00:00:00.000Z" });
    const changed = emailChangedNoticeEmail({ name: "Mo", newEmail: "mo@new.test", stage: "changed", at: "2026-10-09T00:00:00.000Z" });
    expect(requested.subject).toMatch(/asked to change/);
    expect(requested.text).toMatch(/Nothing changes until/);
    expect(requested.text).toMatch(/change your password/);
    expect(changed.subject).toMatch(/was changed/);
    expect(changed.text).toContain("mo@new.test");
    for (const c of [requested, changed]) expect(c.text + c.html).not.toMatch(/https?:\/\//);
  });

  it("password changed notice: changed / reset / set", () => {
    const changed = passwordChangedNoticeEmail({ name: "Mo", via: "changed", at: "2026-10-09T00:00:00.000Z" });
    const reset = passwordChangedNoticeEmail({ name: "Mo", via: "reset", at: "2026-10-09T00:00:00.000Z" });
    const set = passwordChangedNoticeEmail({ name: "Mo", via: "set", at: "2026-10-09T00:00:00.000Z" });
    expect(changed.subject).toBe("Your Proofline password was changed");
    expect(reset.text).toMatch(/reset link/);
    expect(set.subject).toBe("A password was added to your Proofline account");
    for (const c of [changed, reset, set]) {
      expect(c.text).toMatch(/If this wasn't you/);
      expect(c.text + c.html).not.toMatch(/undefined|null/);
    }
    // The app says "Log out" (UX-04): the notice says devices were logged out, never "signed out".
    expect(changed.text).toContain("Every other device was logged out.");
    expect(changed.text + reset.text).not.toMatch(/signed out/);
  });

  it("Google sign-in added notice (SEC-03): names the Google account, says what to do if it wasn't you, never a link", () => {
    const c = googleConnectedNoticeEmail({ name: "Mo <b>", googleEmail: "mo.personal@gmail.com", at: "2026-10-09T00:00:00.000Z" });
    expect(c.subject).toBe("Google sign-in was added to your Proofline account");
    expect(c.text).toContain("The Google account mo.personal@gmail.com can now sign in to your Proofline account");
    expect(c.text).toMatch(/If this wasn't you, sign in, open My account, press Disconnect/);
    expect(c.html).toContain("Mo &lt;b&gt;");
    expect(c.text + c.html).not.toMatch(/undefined|null|https?:/);
  });
});
