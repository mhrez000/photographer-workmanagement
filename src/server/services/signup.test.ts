/**
 * Public sign-up ("Create your studio"): Zod, the generic taken-email answer, slug suffixes, the IP rate limit,
 * the audit rows (cause "signup"). The session cookie (`signUpAndSignIn`) is covered in signup.session.test.ts.
 */
import { count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first } from "@/db/index";
import { activityEvents, jobTypes, organisationSettings, organisations, users, workflows } from "@/db/schema";
import { fakeClock, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { DEFAULT_JOB_TYPES, SIGNUP_RATE_LIMIT } from "@/lib/constants";
import { verifyPassword } from "@/server/auth/password";
import { buildContextFromDb } from "@/server/auth/session";
import { RateLimitedError, ValidationError } from "@/server/errors";
import { authenticate } from "./auth";
import { EMAIL_IN_USE_MESSAGE, signUp } from "./organisations";

let db: TestDb;
let ids: SeedIds;

const GOOD = { ownerName: "Mo Carter", email: "mo@northlight.test", password: "CorrectHorse9!", studioName: "Northlight Studio", timezone: "Australia/Brisbane", ip: "1.1.1.1", userAgent: "vitest" };

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db); // an existing studio (slug "studio") with taken emails
});
afterEach(() => fakeClock.reset());

const orgCount = async () => (await first(db.select({ n: count() }).from(organisations)))?.n ?? 0;
const eventsOf = async (type: string) => db.select().from(activityEvents).where(eq(activityEvents.eventType, type)).orderBy(activityEvents.createdAt, activityEvents.rowid);
const fail = async (raw: unknown) => signUp(db, raw).catch((e: unknown) => e);

describe("signUp — happy path", () => {
  it("creates the studio + owner + structure, returns ids, and the owner can sign in straight away", async () => {
    const result = await signUp(db, GOOD, { requestId: "req-signup" });
    expect(result).toMatchObject({ slug: "northlight-studio", name: "Mo Carter", email: "mo@northlight.test", role: "photographer", sessionVersion: 1 });

    const org = await first(db.select().from(organisations).where(eq(organisations.id, result.organisationId)));
    expect(org).toMatchObject({ name: "Northlight Studio", slug: "northlight-studio", createdAt: "2026-10-08T00:00:00.000Z" });
    const settings = await first(db.select().from(organisationSettings).where(eq(organisationSettings.organisationId, result.organisationId)));
    expect(settings).toMatchObject({ timezone: "Australia/Brisbane", primaryOwnerUserId: result.userId, advancedToolsEnabled: false, timeTrackingEnabled: false });
    const owner = await first(db.select().from(users).where(eq(users.id, result.userId)));
    expect(owner).toMatchObject({ organisationId: result.organisationId, role: "photographer", isAdmin: true, isActive: true, acceptedAt: "2026-10-08T00:00:00.000Z", canReviewSubmissions: true, canViewAnalytics: true });
    expect(await verifyPassword(GOOD.password, owner?.passwordHash ?? "")).toBe(true);

    expect(await db.select().from(workflows).where(eq(workflows.organisationId, result.organisationId))).toHaveLength(1);
    expect(await db.select().from(jobTypes).where(eq(jobTypes.organisationId, result.organisationId))).toHaveLength(DEFAULT_JOB_TYPES.length);

    await expect(authenticate(db, { email: "MO@northlight.test", password: GOOD.password })).resolves.toMatchObject({ id: result.userId, role: "photographer" });
    const ctx = await buildContextFromDb(db, result.userId);
    expect(ctx).toMatchObject({ isAdmin: true, isPrimaryOwner: true, organisationId: result.organisationId });
  });

  it("writes org.created and user.created with cause 'signup' and the request id; never the password", async () => {
    const result = await signUp(db, GOOD, { requestId: "req-signup" });
    const [orgEvent] = await eventsOf("org.created");
    expect(orgEvent).toMatchObject({ organisationId: result.organisationId, entityId: result.organisationId, actorUserId: result.userId, visibility: "management" });
    expect(orgEvent.metadata).toMatchObject({ cause: "signup", requestId: "req-signup" });
    const created = (await eventsOf("user.created")).filter((e) => e.organisationId === result.organisationId);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ entityId: result.userId, actorUserId: result.userId, newValue: { email: "mo@northlight.test", role: "photographer", isAdmin: true } });
    expect(created[0].metadata).toMatchObject({ cause: "signup", bootstrap: true, primaryOwner: true });
    const all = await db.select().from(activityEvents).where(eq(activityEvents.organisationId, result.organisationId));
    expect(JSON.stringify(all)).not.toContain(GOOD.password);
    expect(all.every((e) => (e.metadata as { cause?: string }).cause === "signup")).toBe(true);
  });

  it("timezone is optional (defaults to the studio default) and emails are normalised", async () => {
    const result = await signUp(db, { ownerName: GOOD.ownerName, email: "  Mo@Northlight.test ", password: GOOD.password, studioName: GOOD.studioName, ip: GOOD.ip });
    expect((await first(db.select().from(organisationSettings).where(eq(organisationSettings.organisationId, result.organisationId))))?.timezone).toBe("Australia/Sydney");
    expect(result.email).toBe("mo@northlight.test");
  });
});

describe("signUp — validation", () => {
  it("rejects a short password, a 1-character studio name, a bad timezone, a bad email and unknown keys (400, nothing created)", async () => {
    const before = await orgCount();
    for (const [i, raw] of [
      { ...GOOD, password: "short1!" },
      { ...GOOD, studioName: "N" },
      { ...GOOD, studioName: "x".repeat(81) },
      { ...GOOD, timezone: "Mars/Olympus" },
      { ...GOOD, email: "not-an-email" },
      { ...GOOD, ownerName: "" },
      { ...GOOD, isAdmin: true },
      null,
      "string",
    ].entries()) {
      // Each from its own network: a form with mistakes still counts toward the sign-up limit (SEC-04).
      const err = await fail(raw && typeof raw === "object" ? { ...raw, ip: `10.0.0.${i}` } : raw);
      expect(err, JSON.stringify(raw)).toBeInstanceOf(ValidationError);
    }
    expect(await orgCount()).toBe(before);
  });

  it("a taken email (any case / spacing, any org, any role) gets ONE generic message in fieldErrors.email and creates nothing", async () => {
    const before = await orgCount();
    for (const email of [ids.emails.owner, ids.emails.editor1.toUpperCase(), ` ${ids.emails.client} `]) {
      const err = await fail({ ...GOOD, email });
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe(EMAIL_IN_USE_MESSAGE);
      expect((err as ValidationError).details).toEqual({ formErrors: [], fieldErrors: { email: [EMAIL_IN_USE_MESSAGE] } });
      expect((err as Error).message).not.toMatch(/studio|editor|client|photographer/i);
    }
    expect(await orgCount()).toBe(before);
    expect(await eventsOf("org.created")).toHaveLength(0);
  });
});

describe("signUp — one 400 says everything", () => {
  it("a taken email AND a short password come back together in one validation error", async () => {
    const err = await fail({ ...GOOD, email: ids.emails.editor1, password: "short" });
    expect(err).toBeInstanceOf(ValidationError);
    const details = (err as ValidationError).details as { fieldErrors: Record<string, string[]> };
    expect(details.fieldErrors.email).toEqual([EMAIL_IN_USE_MESSAGE]);
    expect(details.fieldErrors.password?.[0]).toMatch(/at least 10 characters/);
    expect(await eventsOf("org.created")).toHaveLength(0);
  });

  it("a free email with a short password reports only the password; a malformed email never triggers the lookup", async () => {
    const a = (await fail({ ...GOOD, password: "short" })) as ValidationError;
    expect((a.details as { fieldErrors: Record<string, string[]> }).fieldErrors).toEqual({ password: [expect.stringMatching(/at least 10/)] });
    const b = (await fail({ ...GOOD, email: "not-an-email", password: "short" })) as ValidationError;
    expect((b.details as { fieldErrors: Record<string, string[]> }).fieldErrors.email).toEqual([expect.stringMatching(/valid email/)]);
  });

  it("the new owner's last_login_at is set at sign-up (they are signed in)", async () => {
    const result = await signUp(db, GOOD);
    expect((await first(db.select().from(users).where(eq(users.id, result.userId))))?.lastLoginAt).toBe(fakeClock.now());
  });
});

describe("signUp — slugs", () => {
  it("adds a numeric suffix when the slug is taken, and falls back to 'studio' for an unusable name", async () => {
    const a = await signUp(db, { ...GOOD, studioName: "Studio", email: "a@northlight.test" });
    expect(a.slug).toBe("studio-2");
    const b = await signUp(db, { ...GOOD, studioName: "  STUDIO!  ", email: "b@northlight.test" });
    expect(b.slug).toBe("studio-3");
    const c = await signUp(db, { ...GOOD, studioName: "!!", email: "c@northlight.test" });
    expect(c.slug).toBe("studio-4");
    const d = await signUp(db, { ...GOOD, studioName: "Café Lumière Photo", email: "d@northlight.test" });
    expect(d.slug).toBe("cafe-lumiere-photo");
  });
});

describe("signUp — rate limit", () => {
  it(`allows ${SIGNUP_RATE_LIMIT.attempts} sign-ups per IP per hour, then 429 with retry-after; another IP is unaffected; the window drains`, async () => {
    for (let i = 0; i < SIGNUP_RATE_LIMIT.attempts; i += 1) {
      await signUp(db, { ...GOOD, ip: "7.7.7.7", email: `p${i}@northlight.test`, studioName: `Studio ${i}` });
    }
    const err = await fail({ ...GOOD, ip: "7.7.7.7", email: "blocked@northlight.test" });
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    expect(await first(db.select().from(users).where(eq(users.email, "blocked@northlight.test")))).toBeUndefined();

    await expect(signUp(db, { ...GOOD, ip: "8.8.8.8", email: "other-ip@northlight.test" })).resolves.toMatchObject({ email: "other-ip@northlight.test" });

    // The hour drains (the Postgres limiter follows the services' clock).
    fakeClock.advanceMinutes(SIGNUP_RATE_LIMIT.windowMinutes + 1);
    await expect(signUp(db, { ...GOOD, ip: "7.7.7.7", email: "blocked@northlight.test" })).resolves.toMatchObject({ email: "blocked@northlight.test" });
  });

  it("failed attempts count too (a taken email five times blocks the IP)", async () => {
    for (let i = 0; i < SIGNUP_RATE_LIMIT.attempts; i += 1) expect(await fail({ ...GOOD, ip: "9.9.9.9", email: ids.emails.owner })).toBeInstanceOf(ValidationError);
    expect(await fail({ ...GOOD, ip: "9.9.9.9", email: "fresh@northlight.test" })).toBeInstanceOf(RateLimitedError);
  });

  it("without a known IP the limit is keyed by email, so one deployment never shares an 'unknown' bucket", async () => {
    for (let i = 0; i < SIGNUP_RATE_LIMIT.attempts; i += 1) expect(await fail({ ...GOOD, ip: null, email: ids.emails.owner })).toBeInstanceOf(ValidationError);
    expect(await fail({ ...GOOD, ip: null, email: ids.emails.owner })).toBeInstanceOf(RateLimitedError);
    await expect(signUp(db, { ...GOOD, ip: null, email: "someone-else@northlight.test" })).resolves.toMatchObject({ email: "someone-else@northlight.test" });
  });
});
