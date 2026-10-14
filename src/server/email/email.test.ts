/**
 * Email channel (front door): provider selection, the console provider's one-line log (never the token / body),
 * resend failures returned (never thrown), and the invite / reset templates.
 */
import { describe, expect, it, vi } from "vitest";
import type { Resend } from "resend";
import { INVITE_TTL_HOURS, RESET_TTL_MINUTES } from "@/lib/constants";
import { emailConfig, emailConfigured, sendEmail, type EmailConfig } from "./index";
import { escapeHtml, inviteEmail, passwordResetEmail, roleInPlainWords } from "./templates";

const TOKEN = "Zx9_secret-token_ABCDEFGHIJKLMNOPQRSTUVWXYZ012";
const RESEND: EmailConfig = { provider: "resend", from: "Proofline <hello@example.com>", configured: true };
const CONSOLE: EmailConfig = { provider: "console", from: null, configured: false };

type SendFn = Resend["emails"]["send"];
type SendArgs = Parameters<SendFn>[0];
type SendResult = Awaited<ReturnType<SendFn>>;
type FakeSend = (args: SendArgs) => Promise<SendResult>;
function fakeResend(send: FakeSend): Pick<Resend, "emails"> {
  return { emails: { send } } as unknown as Pick<Resend, "emails">;
}

describe("emailConfig", () => {
  it("is the console provider unless BOTH RESEND_API_KEY and EMAIL_FROM are set", () => {
    expect(emailConfig({})).toEqual(CONSOLE);
    expect(emailConfig({ RESEND_API_KEY: "re_123" })).toEqual(CONSOLE);
    expect(emailConfig({ EMAIL_FROM: "hello@example.com" })).toEqual(CONSOLE);
    expect(emailConfig({ RESEND_API_KEY: "  ", EMAIL_FROM: "hello@example.com" })).toEqual(CONSOLE);
    expect(emailConfig({ RESEND_API_KEY: "re_123", EMAIL_FROM: " Proofline <hello@example.com> " })).toEqual(RESEND);
    expect(emailConfigured({})).toBe(false);
    expect(emailConfigured({ RESEND_API_KEY: "re_123", EMAIL_FROM: "hello@example.com" })).toBe(true);
  });
});

describe("sendEmail — console provider", () => {
  it("logs ONE line with recipient + subject only: never the body, the html or the token", async () => {
    const log = vi.fn<(line: string) => void>();
    const warn = vi.fn<(line: string) => void>();
    const content = inviteEmail({ studioName: "Northlight", inviterName: "Mo", persona: "editor", inviteUrl: `http://localhost:3000/invite/${TOKEN}`, expiresAt: "2026-10-15T00:00:00.000Z" });
    const result = await sendEmail({ to: "sam@studio.test", ...content }, { config: CONSOLE, log, warn });
    expect(result).toEqual({ ok: false, provider: "console", error: "email_not_configured" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    const line = log.mock.calls[0][0];
    expect(line).toContain("sam@studio.test");
    expect(line).toContain(content.subject);
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain("/invite/");
    expect(line).not.toContain("<");
  });
});

describe("sendEmail — resend provider", () => {
  it("sends from EMAIL_FROM with text + html and reports the provider id", async () => {
    const send = vi.fn<FakeSend>(async () => ({ data: { id: "msg_1" }, error: null }) as SendResult);
    const result = await sendEmail(
      { to: "sam@studio.test", subject: "Hello", text: "plain", html: "<p>plain</p>" },
      { config: RESEND, resendClient: () => fakeResend(send), log: () => undefined, warn: () => undefined },
    );
    expect(result).toEqual({ ok: true, provider: "resend", id: "msg_1" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ from: RESEND.from, to: "sam@studio.test", subject: "Hello", text: "plain", html: "<p>plain</p>" });
  });

  it("omits html when the message has none", async () => {
    const send = vi.fn<FakeSend>(async () => ({ data: { id: "msg_2" }, error: null }) as SendResult);
    await sendEmail({ to: "a@b.test", subject: "S", text: "t" }, { config: RESEND, resendClient: () => fakeResend(send), log: () => undefined });
    expect(send.mock.calls[0][0]).not.toHaveProperty("html");
  });

  it("a rejected send is warned + returned, never thrown", async () => {
    const warn = vi.fn<(line: string) => void>();
    const send = vi.fn<FakeSend>(async () => ({ data: null, error: { name: "validation_error", message: "Invalid `from`" } }) as unknown as SendResult);
    const result = await sendEmail({ to: "a@b.test", subject: "S", text: TOKEN }, { config: RESEND, resendClient: () => fakeResend(send), warn, log: () => undefined });
    expect(result).toEqual({ ok: false, provider: "resend", error: "Invalid `from`" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain(TOKEN);
  });

  it("a thrown network error is warned + returned, never thrown", async () => {
    const warn = vi.fn<(line: string) => void>();
    const result = await sendEmail(
      { to: "a@b.test", subject: "S", text: TOKEN },
      {
        config: RESEND,
        resendClient: () =>
          fakeResend(async () => {
            throw new Error("ECONNRESET");
          }),
        warn,
        log: () => undefined,
      },
    );
    expect(result).toEqual({ ok: false, provider: "resend", error: "ECONNRESET" });
    expect(warn.mock.calls[0][0]).toContain("ECONNRESET");
    expect(warn.mock.calls[0][0]).not.toContain(TOKEN);
  });
});

describe("templates", () => {
  const inviteUrl = `https://app.example.com/invite/${TOKEN}`;

  it("inviteEmail names the studio, the inviter, the role in plain words, the link and the expiry (text + html)", () => {
    const mail = inviteEmail({ studioName: "Northlight Studio", inviterName: "Mo Carter", persona: "editor", inviteUrl, expiresAt: "2026-10-15T03:00:00.000Z", timezone: "Australia/Sydney" });
    expect(mail.subject).toBe("Mo Carter invited you to Northlight Studio on Proofline");
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("Northlight Studio");
      expect(body).toContain("Mo Carter");
      expect(body).toContain("an editor");
      expect(body).toContain(inviteUrl);
      expect(body).toContain(`${Math.round(INVITE_TTL_HOURS / 24)} days`);
      expect(body).toContain("15 Oct 2026");
    }
    expect(mail.html).toContain("<!doctype html>");
    expect(mail.html).toContain(`href="${inviteUrl}"`);
    // plain words only
    expect(mail.text.toLowerCase()).not.toMatch(/workflow|turnaround|utilisation|kanban/);
  });

  it("inviteEmail escapes html in names and says the role per persona", () => {
    const mail = inviteEmail({ studioName: "<b>Evil</b> & Co", inviterName: "Ann <script>", persona: "client", inviteUrl, expiresAt: "2026-10-15T03:00:00.000Z" });
    expect(mail.html).toContain("&lt;b&gt;Evil&lt;/b&gt; &amp; Co");
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("a client (portal access)");
    expect(roleInPlainWords("admin")).toBe("an owner");
    expect(roleInPlainWords("member")).toBe("a photographer");
    expect(roleInPlainWords("editor")).toBe("an editor");
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("passwordResetEmail carries the link, the 60-minute expiry and the single-use note", () => {
    const resetUrl = `https://app.example.com/reset-password?token=${TOKEN}`;
    const mail = passwordResetEmail({ resetUrl, expiresAt: "2026-10-08T01:00:00.000Z", studioName: "Northlight" });
    expect(mail.subject).toBe("Reset your Proofline password");
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain(resetUrl);
      expect(body).toContain(`${RESET_TTL_MINUTES} minutes`);
      expect(body).toContain("Northlight");
      expect(body).toContain("once");
    }
    const anonymous = passwordResetEmail({ resetUrl, expiresAt: "2026-10-08T01:00:00.000Z" });
    expect(anonymous.text).toContain("your Proofline account.");
    expect(anonymous.text).not.toContain("account for");
  });
});
