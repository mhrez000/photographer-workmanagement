import { INVITE_INVALID_MESSAGE, INVITE_LINK_RE, localPath, loginApi, newApi, tokenOfInviteUrl, uniqPassword } from "./api";
import { UI_TEST_TIMEOUT, expect, fillPasswords, gotoReady, itemMentioning, publicForm, retrying, submitButton, test, waitForLink } from "./fixtures";

/**
 * Client portal invites (front door, docs/ROLES.md §7): on the client's page the owner turns on
 * "Client can see their work online", presses Invite someone, and gets a LINK to pass on. The person
 * opens it, chooses a password and lands on /portal seeing only their client's work. The portal must be
 * on when they accept (turning it off kills the link), and a client without the portal cannot be invited.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test("API contract: a client user by link lands on /portal; portal off kills the link; no portal → 422", async ({ api }) => {
  const { clientId, clientName } = await api.createClient("Client link", { portal: true });
  const invite = await api.inviteByLink("client", { label: "Client link", clientId });
  const anon = await newApi();
  const anon2 = await newApi();
  try {
    expect(await anon.inviteLookup(invite.token)).toMatchObject({ valid: true, role: "client", email: invite.email, personaLabel: expect.stringMatching(/client/i) });
    expect((await anon.raw("POST", "/api/auth/login", { email: invite.email, password: "anything-at-all-1" })).status).toBe(401);
    const password = uniqPassword();
    const joined = await anon.acceptInvite(invite.token, password);
    expect(joined.status, JSON.stringify(joined.error)).toBe(200);
    expect(joined.data.redirectTo).toBe("/portal");
    const me = await anon.clientMe();
    expect(me).toMatchObject({ kind: "client", clientName, email: invite.email });
    // The staff API is closed to them; the portal is open.
    expect([403, 404]).toContain((await anon.raw("GET", "/api/jobs")).status);
    expect((await anon.raw("GET", "/api/portal/jobs")).status).toBe(200);
    const session = await loginApi(invite.email, password);
    expect((await session.clientMe()).kind).toBe("client");
    await session.dispose();

    // Portal off after the invite: joining is refused with the one generic message (the token itself stays
    // live, so nothing about the client's portal leaks through the public lookup).
    const other = await api.createClient("Client off", { portal: true });
    const second = await api.inviteByLink("client", { label: "Client off", clientId: other.clientId });
    expect((await anon2.inviteLookup(second.token)).valid).toBe(true);
    await api.setClientPortal(other.clientId, { portalEnabled: false });
    const refused = await anon2.acceptInvite(second.token, uniqPassword());
    expect(refused.status).toBe(400);
    expect(refused.error?.message).toBe(INVITE_INVALID_MESSAGE);
    expect((await anon2.raw("GET", "/api/auth/me")).status).toBe(401);
    // Back on: the refused attempt did not burn the link; joining works and lands on the portal.
    await api.setClientPortal(other.clientId, { portalEnabled: true });
    expect((await anon2.inviteLookup(second.token)).valid).toBe(true);
    const laterJoin = await anon2.acceptInvite(second.token, uniqPassword());
    expect(laterJoin.status, JSON.stringify(laterJoin.error)).toBe(200);
    expect(laterJoin.data.redirectTo).toBe("/portal");
    // Portal off again: even a joined client user is refused at login (the same 401 as a wrong password).
    await api.setClientPortal(other.clientId, { portalEnabled: false });
    expect([401, 403]).toContain((await anon2.raw("GET", "/api/portal/jobs")).status);

    // A client without the portal cannot even be invited.
    const noPortal = await api.createClient("No portal");
    const res = await api.raw("POST", "/api/users", { email: `e2e-noportal-${stamp()}@studio.test`, name: "E2E No Portal", role: "client", clientId: noPortal.clientId, method: "link" });
    expect(res.status).toBe(422);
  } finally {
    await anon.dispose();
    await anon2.dispose();
  }
});

test("owner: turn the portal on, Invite someone, pass the link on → the client joins and sees their work", async ({ page, pageWithState, api }) => {
  const s = stamp();
  const { clientId, clientName } = await api.createClient("Client invite UI");
  const name = `E2E Client Person ${s}`;
  const email = `e2e-client-ui-${s}@studio.test`;
  const studio = (await api.settings()).organisation.name;
  const portalOn = async () => (await api.get<{ client: { portalEnabled: boolean } }>(`/api/clients/${clientId}`)).client.portalEnabled;

  const main = page.getByRole("main");
  const portal = main.getByRole("switch", { name: /client can see their work online/i });
  await gotoReady(page, `/clients/${clientId}`, portal);
  await expect(portal).toHaveAttribute("aria-checked", "false");
  // Off: inviting is not possible yet, and the page says why.
  const inviteButton = main.getByRole("button", { name: /^invite someone$/i });
  await expect(inviteButton).toBeDisabled();
  await expect(main).toContainText(/turn on online access first/i);
  await retrying(async () => {
    if (!(await portalOn())) await portal.click({ timeout: 5_000 });
    await expect.poll(portalOn, { timeout: 8_000 }).toBe(true);
  });
  await expect(portal).toHaveAttribute("aria-checked", "true");
  await expect(inviteButton).toBeEnabled();

  // Invite by link.
  const dialog = page.getByRole("dialog");
  await retrying(async () => {
    if (!(await dialog.isVisible())) await inviteButton.click({ timeout: 5_000 });
    await expect(dialog).toBeVisible({ timeout: 3_000 });
  });
  await expect(dialog.getByRole("heading", { name: new RegExp(`invite someone from ${clientName}`, "i") })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /set a temporary password instead/i })).toBeVisible();
  await dialog.getByRole("textbox", { name: /^name/i }).fill(name);
  await dialog.getByRole("textbox", { name: /^email/i }).fill(email);
  await dialog.getByRole("button", { name: /^invite$/i }).click();
  const link = await waitForLink(dialog, INVITE_LINK_RE);
  const token = tokenOfInviteUrl(link);
  await expect(dialog.getByRole("heading", { name: new RegExp(`invite link for ${name}`, "i") })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^copy link$/i })).toBeVisible();
  await expect(dialog.locator('code[aria-label="Temporary password"]')).toHaveCount(0);
  const anon = await newApi();
  expect(await anon.inviteLookup(token)).toMatchObject({ valid: true, role: "client", email });
  await dialog.getByRole("button", { name: /^done$/i }).click();
  await expect(dialog).toBeHidden();
  // The client's people list shows them as pending.
  const row = itemMentioning(main, name);
  await expect(row).toBeVisible();
  await expect(row).toContainText(/invite pending/i);

  // The person joins in their own browser and lands on their work.
  const joiner = await pageWithState(undefined);
  await joiner.goto(localPath(link), { waitUntil: "domcontentloaded" });
  await expect(joiner.getByRole("heading", { level: 1 })).toContainText(studio);
  await expect(joiner.locator("body")).toContainText(/client/i);
  const form = publicForm(joiner);
  const password = uniqPassword();
  await fillPasswords(form, password);
  await submitButton(form).click();
  await expect(joiner).toHaveURL(/\/portal(\?|\/|$)/, { timeout: 60_000 });
  await expect(joiner.getByRole("heading", { name: "Your work" })).toBeVisible();
  await expect(joiner.getByRole("banner")).toContainText(clientName);
  // Never the staff shell.
  await expect(joiner.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  expect((await anon.inviteLookup(token)).valid).toBe(false);
  await anon.dispose();

  // The owner sees them joined.
  await page.reload();
  const after = itemMentioning(main, name);
  await expect(after).toBeVisible();
  await expect(after).not.toContainText(/invite pending/i);
  const session = await loginApi(email, password);
  expect((await session.clientMe()).clientName).toBe(clientName);
  await session.dispose();
});
