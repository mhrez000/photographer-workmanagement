import type { Page } from "@playwright/test";
import { INVITE_INVALID_MESSAGE, INVITE_LINK_RE, localPath, loginApi, newApi, signUpStudio, tokenOfInviteUrl, uniqPassword, type ActivityItem, type Paginated } from "./api";
import { UI_TEST_TIMEOUT, dialogButton, expect, fillPasswords, gotoReady, grantClipboard, itemMentioning, publicForm, readClipboard, retrying, storageFor, submitButton, test, waitForLink } from "./fixtures";

/**
 * Invite links (front door, `POST /api/users` with `method: "link"`, the default): the owner invites an
 * editor from People, the link is shown once with Copy link (the dev server has no email set up), People
 * shows "Invite pending", the editor opens /invite/<token> in their own browser, chooses a password and
 * lands on My jobs; the owner then sees them active. "Send a new link" kills the old one; "Revoke invite"
 * kills every link. Login is refused until the invite is accepted. Tokens never appear in the history.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

/** Joins through the invite page: the password, then the button; lands on `home`. */
async function joinThroughLink(page: Page, link: string, password: string, home: RegExp): Promise<void> {
  await page.goto(localPath(link), { waitUntil: "domcontentloaded" });
  const form = publicForm(page);
  await expect(form).toBeVisible();
  await fillPasswords(form, password);
  await submitButton(form).click();
  await expect(page).toHaveURL(home, { timeout: 60_000 });
}

test("API contract: no password until accepted; accept signs in; resend and revoke kill the old links; the history never holds a token", async ({ api, apiAs }) => {
  const studio = (await api.settings()).organisation.name;
  const email = await api.emailSettings();
  const invite = await api.inviteByLink("editor", "Link api");
  expect(invite.emailed).toBe(email.configured);
  expect(Date.parse(invite.expiresAt)).toBeGreaterThan(Date.now() + 6 * 86_400_000);
  const anon = await newApi();
  const anon2 = await newApi();
  try {
    // Not accepted: login refused with the generic 401, whatever the password.
    expect((await anon.raw("POST", "/api/auth/login", { email: invite.email, password: "anything-at-all-1" })).status).toBe(401);
    // The live link says who it is for.
    expect(await anon.inviteLookup(invite.token)).toMatchObject({ valid: true, email: invite.email, role: "editor", studioName: studio, name: invite.name });
    // A trailing %20 (mail clients encode a trailing space) and plain whitespace are forgiven on the API and the page alike.
    expect((await anon.inviteLookup(`${invite.token}%20`)).valid).toBe(true);
    expect((await anon.inviteLookup(`%20${invite.token}%20`)).valid).toBe(true);
    expect((await anon.pageStatus(`/invite/${invite.token}%20`)).status).toBe(200);
    // Pending = a ghost: not in the Assign picker, not an editor row, but listed as pending for the owner.
    const options = await api.get<{ editor: { id: string }; email: string }[]>("/api/editors/options");
    expect(options.map((o) => o.editor.id)).not.toContain(invite.user.id);
    expect(options.every((o) => typeof o.email === "string" && o.email.includes("@"))).toBe(true);

    // Send a new link: the old one dies the same moment.
    const resent = await api.resendInvite(invite.user.id);
    expect(resent.token).not.toBe(invite.token);
    expect((await anon.inviteLookup(invite.token)).valid).toBe(false);
    expect((await anon.inviteLookup(resent.token)).valid).toBe(true);
    const dead = await anon.acceptInvite(invite.token, uniqPassword());
    expect(dead.status).toBe(400);
    expect(dead.error?.message).toBe(INVITE_INVALID_MESSAGE);
    // A weak password on a live link is a field error, and the link stays live.
    const weak = await anon.acceptInvite(resent.token, "short");
    expect(weak.status).toBe(400);
    expect((await anon.inviteLookup(resent.token)).valid).toBe(true);

    // Accept the fresh link: signed in as the editor, sent to My jobs; the link is then used up.
    const password = uniqPassword();
    const joined = await anon.acceptInvite(resent.token, password);
    expect(joined.status, JSON.stringify(joined.error)).toBe(200);
    expect(joined.data.redirectTo).toBe("/my-jobs");
    expect(joined.data.user).toMatchObject({ email: invite.email, role: "editor" });
    expect((await anon.me()).user.email).toBe(invite.email);
    expect((await anon.inviteLookup(resent.token)).valid).toBe(false);
    // Joined: now an editor like any other, with "Last signed in" set by the acceptance itself.
    expect((await api.get<{ editor: { id: string } }[]>("/api/editors/options")).map((o) => o.editor.id)).toContain(invite.user.id);
    expect((await api.get<{ profile: { lastLoginAt: string | null } | null }>(`/api/users/${invite.user.id}`)).profile?.lastLoginAt).toBeTruthy();
    expect((await anon2.acceptInvite(resent.token, uniqPassword())).status).toBe(400);
    const session = await loginApi(invite.email, password);
    expect((await session.me()).user).toMatchObject({ role: "editor", persona: "editor" });
    await session.dispose();
    // Joined: nothing to resend or revoke (422), and People shows them as accepted.
    expect((await api.raw("POST", `/api/users/${invite.user.id}/invite/resend`)).status).toBe(422);
    expect((await api.raw("POST", `/api/users/${invite.user.id}/invite/revoke`)).status).toBe(422);
    const profile = await api.get<{ profile: { acceptedAt: string | null } | null }>(`/api/users/${invite.user.id}`);
    expect(profile.profile?.acceptedAt).toBeTruthy();

    // Revoke: every link stops working; the account stays with no way in.
    const second = await api.inviteByLink("editor", "Link revoke");
    expect((await api.revokeInvite(second.user.id)).revoked).toBe(1);
    expect((await anon2.inviteLookup(second.token)).valid).toBe(false);
    const refused = await anon2.acceptInvite(second.token, uniqPassword());
    expect(refused.status).toBe(400);
    expect(refused.error?.message).toBe(INVITE_INVALID_MESSAGE);
    expect((await anon2.raw("POST", "/api/auth/login", { email: second.email, password: "anything-at-all-1" })).status).toBe(401);
    expect((await api.userByEmail(second.email)).isActive).toBe(true);
    // Revoking again is still a success (0 links).
    expect((await api.revokeInvite(second.user.id)).revoked).toBe(0);
    // A new link after a revoke works.
    const third = await api.resendInvite(second.user.id);
    expect((await anon2.inviteLookup(third.token)).valid).toBe(true);

    // Nonsense tokens are simply invalid (no 500, no hint).
    for (const bad of ["x", "not-a-token-at-all-but-long-enough-to-pass", "%2e%2e%2f"]) {
      const res = await anon2.raw("GET", `/api/auth/invite/${bad}`);
      expect(res.status, bad).toBeLessThan(500);
      expect(JSON.stringify(res.data ?? res.error)).not.toContain(third.token);
    }

    // The history records invites and revokes, never a plain token.
    const feed = await api.get<Paginated<ActivityItem>>("/api/activity?limit=200");
    const types = feed.items.map((e) => e.eventType);
    expect(types).toContain("user.invite_sent");
    expect(types).toContain("user.invite_revoked");
    const text = JSON.stringify(feed);
    for (const token of [invite.token, resent.token, second.token, third.token]) expect(text).not.toContain(token);

    // Only admins invite or manage invites.
    const editor = await apiAs("editor");
    expect((await editor.raw("POST", "/api/users", { email: `e2e-nope-${Date.now()}@studio.test`, name: "Nope", role: "editor", method: "link" })).status).toBe(403);
    expect((await editor.raw("POST", `/api/users/${second.user.id}/invite/resend`)).status).toBe(403);
    expect((await editor.raw("POST", `/api/users/${second.user.id}/invite/revoke`)).status).toBe(403);
  } finally {
    await anon.dispose();
    await anon2.dispose();
  }
});

test("owner invites an editor by link from People → Invite pending → the editor joins through the link → active", async ({ page, pageWithState, api }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const name = `E2E Linked Editor ${stamp}`;
  const email = `e2e-ui-link-${stamp}@studio.test`;
  const studio = (await api.settings()).organisation.name;

  await gotoReady(page, "/settings/people?invite=editor", page.getByRole("dialog"));
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /invite someone/i })).toBeVisible();
  await dialog.getByRole("radiogroup", { name: "Role" }).getByRole("radio", { name: /^Editor/ }).click();
  // The default is a link; the temporary password is the fallback, one click away.
  await expect(dialog.getByRole("button", { name: /set a temporary password instead/i })).toBeVisible();
  await dialog.getByRole("textbox", { name: /full name|^name/i }).fill(name);
  await dialog.getByRole("textbox", { name: /email/i }).fill(email);
  await dialogButton(page, /^invite$/i).click();

  // The link, shown once, with Copy link; no temporary password anywhere.
  const link = await waitForLink(dialog, INVITE_LINK_RE);
  const token = tokenOfInviteUrl(link);
  await expect(dialog.getByRole("heading", { name: new RegExp(`invite link for ${name}`, "i") })).toBeVisible();
  await expect(dialog.locator('code[aria-label="Temporary password"]')).toHaveCount(0);
  const copy = dialog.getByRole("button", { name: /^copy link$/i });
  await expect(copy).toBeVisible();
  await grantClipboard(page);
  await copy.click();
  const copied = await readClipboard(page);
  if (copied) expect(copied).toContain(`/invite/${token}`);
  // Copying never invalidates the link.
  const anon = await newApi();
  expect(await anon.inviteLookup(token)).toMatchObject({ valid: true, email, role: "editor" });
  const invited = await api.userByEmail(email);
  expect(invited.role).toBe("editor");

  // People: Invite pending.
  await dialogButton(page, /^done$/i).click();
  await expect(dialog).toBeHidden();
  await gotoReady(page, `/settings/people?q=${encodeURIComponent(stamp)}`, page.getByRole("main").getByText(name).first());
  const row = itemMentioning(page.getByRole("main"), name);
  await expect(row).toContainText(/invite pending/i);
  await expect(row).not.toContainText(/\bActive\b/);

  // The editor, in their own browser: who invited them, the studio, the role; one password; My jobs.
  const joiner = await pageWithState(undefined);
  await joiner.goto(localPath(link), { waitUntil: "domcontentloaded" });
  await expect(joiner.getByRole("heading", { level: 1 })).toContainText(studio);
  await expect(joiner.locator("body")).toContainText(/editor/i);
  await expect(joiner.getByRole("textbox", { name: /^email/i })).toHaveValue(email);
  await expect(joiner.getByRole("textbox", { name: /^your name/i })).toHaveValue(name);
  const password = uniqPassword();
  await joinThroughLink(joiner, link, password, /\/my-jobs/);
  await expect(joiner.getByRole("banner").getByRole("button", { name: `Account menu for ${name}` })).toBeVisible();
  expect((await anon.inviteLookup(token)).valid).toBe(false);
  await anon.dispose();

  // The owner sees them active; the chosen password signs them in.
  await page.reload();
  const after = itemMentioning(page.getByRole("main"), name);
  await expect(after).toBeVisible();
  await expect(after).not.toContainText(/invite pending/i);
  await expect(after).toContainText(/\bEditor\b/);
  const session = await loginApi(email, password);
  expect((await session.me()).user.email).toBe(email);
  await session.dispose();
});

test("the person's page: Invite pending with Send a new link (old link dies, new one shows once) and Revoke invite", async ({ page, api }) => {
  const invite = await api.inviteByLink("editor", "Pending page");
  const anon = await newApi();
  try {
    await gotoReady(page, `/settings/people/${invite.user.id}`, page.getByRole("main").getByText(/invite pending/i).first());
    const main = page.getByRole("main");
    await expect(main.getByText(/not joined yet/i).first()).toBeVisible();
    // The plain link is not stored: no Copy link until a new one is made.
    await expect(main.locator('code[aria-label="Invite link"]')).toHaveCount(0);
    const resend = main.getByRole("button", { name: /^send a new link$/i });
    const revoke = main.getByRole("button", { name: /^revoke invite$/i });
    await expect(resend).toBeVisible();
    await expect(revoke).toBeVisible();

    // Send a new link (confirm) → the fresh link shows once; the old link is dead.
    await retrying(async () => {
      if (!(await page.getByRole("dialog").isVisible())) await resend.click({ timeout: 5_000 });
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 3_000 });
    });
    await dialogButton(page, /^send a new link$/i).click();
    const fresh = await waitForLink(main, INVITE_LINK_RE);
    const freshToken = tokenOfInviteUrl(fresh);
    expect(freshToken).not.toBe(invite.token);
    expect((await anon.inviteLookup(invite.token)).valid).toBe(false);
    expect((await anon.inviteLookup(freshToken)).valid).toBe(true);
    await expect(main.getByRole("button", { name: /^copy link$/i })).toBeVisible();

    // Revoke (confirm) → nothing works for them any more.
    await retrying(async () => {
      if (!(await page.getByRole("dialog").isVisible())) await revoke.click({ timeout: 5_000 });
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 3_000 });
    });
    await dialogButton(page, /^revoke invite$/i).click();
    await expect.poll(async () => (await anon.inviteLookup(freshToken)).valid, { timeout: 15_000 }).toBe(false);
    const refused = await anon.acceptInvite(freshToken, uniqPassword());
    expect(refused.status).toBe(400);
    expect(refused.error?.message).toBe(INVITE_INVALID_MESSAGE);
    expect((await anon.raw("POST", "/api/auth/login", { email: invite.email, password: uniqPassword() })).status).toBe(401);
    // The page says so: still pending, and the only way back in is a new link.
    await page.reload();
    await expect(main.getByText(/invite pending/i).first()).toBeVisible();
    await expect(main.getByRole("button", { name: /send a new link/i })).toBeVisible();
    await expect(main.getByRole("button", { name: /^revoke invite$/i })).toHaveCount(0);
  } finally {
    await anon.dispose();
  }
});

test("a dead invite link shows a plain explanation, not a form", async ({ pageWithState, api }) => {
  const invite = await api.inviteByLink("editor", "Dead link");
  await api.revokeInvite(invite.user.id);
  const page = await pageWithState(undefined);
  await page.goto(`/invite/${invite.token}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 })).toContainText(INVITE_INVALID_MESSAGE);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.locator('a[href^="/login"]').first()).toBeVisible();
  // The copy is neutral (a pasted-wrong link is the common case) and names no owner-side menu. Signed out, joining
  // before is the likeliest reason, so "Already joined? Sign in below." leads (UX-06); one heading, one sign-in (UX-14).
  const card = page.locator("[data-invalid-link]").getByRole("alert");
  await expect(card).toContainText(/^Already joined\? Sign in below\./);
  await expect(card).toContainText(/check you copied the whole link/i);
  await expect(card).not.toContainText(/settings|didn.t open/i);
  await expect(page.getByRole("main").locator('a[href^="/login"]')).toHaveCount(1);
  // So does a token nobody ever issued, a truncated one, and /invite with no token at all (never the app's 404).
  await page.goto("/invite/this-link-was-never-issued-by-anyone-at-all", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 })).toContainText(INVITE_INVALID_MESSAGE);
  await page.goto(`/invite/${invite.token.slice(0, 12)}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 })).toContainText(INVITE_INVALID_MESSAGE);
  await page.goto("/invite", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 })).toContainText(INVITE_INVALID_MESSAGE);
  await expect(page.getByText("The link is missing its last part.")).toBeVisible();
  await expect(page.getByText(/browse jobs|error 404/i)).toHaveCount(0);
  await expect(page.locator('a[href^="/login"]').first()).toBeVisible();
});

test("a live link with a trailing %20 opens the form; a pending invitee gets a kind hint on /login and /forgot-password", async ({ pageWithState, api }) => {
  const invite = await api.inviteByLink("editor", "Encoded space");
  const page = await pageWithState(undefined);
  await page.goto(`/invite/${invite.token}%20`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/^join /i);
  await expect(publicForm(page).locator('input[type="password"]')).toHaveCount(1);
  // The Join button waits for a long-enough password; the live hint says how many characters to go.
  await fillPasswords(publicForm(page), "short");
  await expect(submitButton(publicForm(page))).toBeDisabled();
  await expect(publicForm(page).getByText(/5 more characters to go/i)).toBeVisible();
  // Clearing the prefilled name is an error, not a silent keep.
  await fillPasswords(publicForm(page), uniqPassword());
  await publicForm(page).getByRole("textbox", { name: /your name/i }).fill("");
  await submitButton(publicForm(page)).click();
  await expect(publicForm(page).getByText(/enter your name/i)).toBeVisible();
  await expect(page).toHaveURL(/\/invite\//);
  expect((await api.inviteLookup(invite.token)).valid).toBe(true);

  // The same person tries to sign in or reset instead: the generic message, plus the one hint that helps them.
  await page.goto("/login?from=invite", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-demo-panel]"), "no demo panel for an invitee").toHaveCount(0);
  const login = publicForm(page);
  await login.getByRole("textbox", { name: /email/i }).fill(invite.email);
  await login.locator('input[type="password"]').fill("guessing-a-password-1");
  await submitButton(login).click();
  await expect(page.getByRole("alert").filter({ hasText: /incorrect email or password/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-login-hint]")).toContainText(/if you were invited, use the link you were sent/i);
  await page.goto(`/forgot-password?email=${encodeURIComponent(invite.email)}`, { waitUntil: "domcontentloaded" });
  await submitButton(publicForm(page)).click();
  await expect(page.getByRole("status").filter({ hasText: /if that email has an account/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("status")).toContainText(/if you were invited, use the link you were sent/i);
  await expect(page.locator('section[aria-labelledby="dev-only-link"]'), "a pending account gets no reset link").toHaveCount(0);
});

test("an invite link opened while SOMEONE ELSE is signed in shows who that is and no form; logging out from there comes back to the invite", async ({ pageWithState, api }) => {
  // A throwaway studio's owner is signed in on `page` (logging out bumps their session_version, so never the shared demo owner).
  // Opening the demo studio's editor invite there must not quietly replace that session.
  const studio = await signUpStudio("Guard");
  const invite = await api.inviteByLink("editor", "Signed-in guard");
  const page = await pageWithState(await storageFor(studio.email, studio.password));
  const owner = { name: studio.ownerName, email: studio.email };
  await page.goto(`/invite/${invite.token}`, { waitUntil: "domcontentloaded" });
  const notice = page.locator("[data-signed-in-notice]");
  await expect(notice).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("This invite is waiting, but this browser is already signed in.")).toBeVisible();
  await expect(notice.getByRole("heading", { name: owner.name })).toBeVisible();
  await expect(notice).toContainText(invite.email);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole("link", { name: /stay signed in/i })).toHaveAttribute("href", /\/home$/);
  // Still that owner, and the link is still live: nothing happened.
  expect((await studio.api.me()).user.email).toBe(owner.email);
  expect((await api.inviteLookup(invite.token)).valid).toBe(true);
  // UX-03: the notice says logging out reaches every device.
  await expect(notice).toContainText("Logging out also logs you out on your other devices.");
  // Log out from the notice: back on the same invite, now with the form (and the session really is gone).
  await notice.getByRole("button", { name: /log out to accept this invite/i }).click();
  await expect(page).toHaveURL(new RegExp(`/invite/${invite.token}$`), { timeout: 30_000 });
  await expect(publicForm(page).locator('input[type="password"]')).toHaveCount(1);
  await expect(page.locator("[data-signed-in-notice]")).toHaveCount(0);
  expect((await page.request.get("/api/auth/me")).status()).toBe(401);
  await studio.api.dispose();
});
