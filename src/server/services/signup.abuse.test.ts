/**
 * Sign-up abuse and confusion (docs/ACCOUNTS.md §2, §6): the hidden "website" honeypot (filled → the one generic 400,
 * still counted toward the limit, nothing created, no field errors to learn from) and the address of an invite nobody
 * has opened yet ("This email has been invited to a studio…" — never the studio's name).
 */
import { count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first } from "@/db/index";
import { activityEvents, organisations, users } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { SIGNUP_HONEYPOT_FIELD, SIGNUP_RATE_LIMIT } from "@/lib/constants";
import { RateLimitedError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import { acceptInvite } from "./invites";
import { EMAIL_IN_USE_MESSAGE, PENDING_INVITE_MESSAGE, SIGNUP_REFUSED_MESSAGE, emailUse, honeypotFilled, signUp } from "./organisations";
import { anonymiseUser, deactivateUser, inviteUser } from "./users";

let db: TestDb;
let ids: SeedIds;

const GOOD = { ownerName: "Mo Carter", email: "mo@northlight.test", password: "CorrectHorse9!", studioName: "Northlight Studio", ip: "1.1.1.1", userAgent: "vitest" };

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { name: "Harbour Light Photography" });
});
afterEach(() => fakeClock.reset());

const orgCount = async () => Number((await db.select({ n: count() }).from(organisations))[0]?.n ?? 0);
const fail = async (raw: unknown) => signUp(db, raw).catch((e: unknown) => e);
const details = (err: unknown) => (err as ValidationError).details as { formErrors: string[]; fieldErrors: Record<string, string[]> };

async function invitePending(email: string): Promise<{ userId: string; token: string }> {
  const ctx = await contextFor(db, ids.users.owner);
  const res = await withTx((tx) => inviteUser(tx, ctx, { email, name: "Sam Pending", role: "editor" }), { db });
  if (!res.invite) throw new Error("expected a link invite");
  return { userId: res.user.id, token: res.invite.token };
}

describe("honeypot", () => {
  it("honeypotFilled: anything but empty / blank / missing counts", () => {
    expect(SIGNUP_HONEYPOT_FIELD).toBe("website");
    for (const raw of [{}, { website: "" }, { website: "   " }, { website: null }, null, "x", []]) expect(honeypotFilled(raw), JSON.stringify(raw)).toBe(false);
    for (const raw of [{ website: "https://spam.example" }, { website: "a" }, { website: 0 }, { website: false }, { website: ["x"] }, { website: {} }]) {
      expect(honeypotFilled(raw), JSON.stringify(raw)).toBe(true);
    }
  });

  it("filled → the one generic 400 (no field errors, even with other mistakes), nothing created or audited", async () => {
    const before = await orgCount();
    const eventsBefore = Number((await db.select({ n: count() }).from(activityEvents))[0]?.n ?? 0);
    for (const raw of [
      { ...GOOD, website: "https://spam.example" },
      { ...GOOD, website: 42 },
      // A bot that also gets everything else wrong learns nothing either.
      { ownerName: "", email: "not-an-email", password: "x", studioName: "", website: "spam", ip: "1.1.1.1" },
      { ...GOOD, email: ids.emails.owner, website: "spam" },
    ]) {
      const err = await fail(raw);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toBe(SIGNUP_REFUSED_MESSAGE);
      expect(details(err)).toEqual({ formErrors: [SIGNUP_REFUSED_MESSAGE], fieldErrors: {} });
    }
    expect(await orgCount()).toBe(before);
    expect(await first(db.select().from(users).where(eq(users.email, GOOD.email)))).toBeUndefined();
    expect(Number((await db.select({ n: count() }).from(activityEvents))[0]?.n ?? 0)).toBe(eventsBefore);
  });

  it("an empty honeypot (what the real form always sends) signs up as usual", async () => {
    await expect(signUp(db, { ...GOOD, website: "" })).resolves.toMatchObject({ email: GOOD.email });
  });

  it("honeypot hits count toward the network's limit, so a bot is throttled like anyone else", async () => {
    for (let i = 0; i < SIGNUP_RATE_LIMIT.attempts; i += 1) expect(await fail({ ...GOOD, email: `bot${i}@spam.test`, website: "x", ip: "6.6.6.6" })).toBeInstanceOf(ValidationError);
    const blocked = await fail({ ...GOOD, ip: "6.6.6.6" });
    expect(blocked).toBeInstanceOf(RateLimitedError);
    expect((blocked as Error).message).toMatch(/^Too many new studios from this network\. Try again in \d+ minutes\.$/);
    await expect(signUp(db, { ...GOOD, ip: "6.6.6.7" })).resolves.toMatchObject({ email: GOOD.email });
  });
});

describe("an address with an invite nobody has opened", () => {
  it("emailUse tells free, pending invite and taken apart", async () => {
    const pending = await invitePending("sam@studio.test");
    expect(await emailUse(db, "fresh@studio.test")).toBe("free");
    expect(await emailUse(db, "sam@studio.test")).toBe("pending_invite");
    expect(await emailUse(db, ids.emails.editor1)).toBe("taken");
    expect(await emailUse(db, ids.emails.inactiveEditor)).toBe("taken");
    await acceptInvite(db, { token: pending.token, password: "BrandNewPass42!" });
    expect(await emailUse(db, "sam@studio.test")).toBe("taken");
  });

  it("sign-up says to use the invite link (as a field error on Email), never naming the studio; nothing is created", async () => {
    await invitePending("sam@studio.test");
    const before = await orgCount();
    const err = await fail({ ...GOOD, email: "SAM@studio.test" });
    expect(err).toBeInstanceOf(ValidationError);
    expect(details(err).fieldErrors).toEqual({ email: [PENDING_INVITE_MESSAGE] });
    expect(PENDING_INVITE_MESSAGE).toBe("This email has been invited to a studio. Use the invite link in your email, or ask the studio to send it again.");
    expect(JSON.stringify(details(err))).not.toContain("Harbour Light");
    expect(await orgCount()).toBe(before);
  });

  it("with other mistakes too, both come back in the one 400", async () => {
    await invitePending("sam@studio.test");
    const err = await fail({ ...GOOD, email: "sam@studio.test", password: "short" });
    expect(details(err).fieldErrors).toMatchObject({ email: [PENDING_INVITE_MESSAGE], password: [expect.stringMatching(/at least 10/)] });
  });

  it("SEC-04: a form with mistakes cannot be used as an unthrottled 'is this address registered?' oracle", async () => {
    await invitePending("sam@studio.test");
    // Same network, each a different address, every other field wrong: the lookup only runs inside the sign-up limit.
    const probes = [ids.emails.owner, "sam@studio.test", "nobody@studio.test", ids.emails.editor1, "free@studio.test"];
    for (const email of probes.slice(0, SIGNUP_RATE_LIMIT.attempts)) {
      expect(await fail({ ...GOOD, email, password: "short", ip: "9.9.9.9" })).toBeInstanceOf(ValidationError);
    }
    for (const email of [ids.emails.owner, "sam@studio.test", "nobody@studio.test"]) {
      const err = await fail({ ...GOOD, email, password: "short", ip: "9.9.9.9" });
      expect(err, email).toBeInstanceOf(RateLimitedError);
      expect(JSON.stringify((err as RateLimitedError).details ?? {})).not.toContain("invited");
    }
    // Without a known network the limit counts per address: 40 tries at one address get 5 answers, then 429s.
    const answers: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const err = await fail({ ...GOOD, email: ids.emails.owner, password: "short", ip: undefined });
      answers.push(err instanceof RateLimitedError ? "429" : "400");
    }
    expect(answers).toEqual(["400", "400", "400", "400", "400", "429", "429", "429"]);
    // A form whose email itself is wrong never looks anything up, and is not counted.
    for (let i = 0; i < 8; i += 1) expect(await fail({ ...GOOD, email: "not-an-email", ip: "8.8.8.8" })).toBeInstanceOf(ValidationError);
    await expect(signUp(db, { ...GOOD, ip: "8.8.8.8" })).resolves.toMatchObject({ email: GOOD.email });
  });

  it("once the invite is accepted, or the person deactivated / anonymised, it is the usual 'already in use' (or free)", async () => {
    const accepted = await invitePending("acc@studio.test");
    await acceptInvite(db, { token: accepted.token, password: "BrandNewPass42!" });
    expect(details(await fail({ ...GOOD, email: "acc@studio.test" })).fieldErrors.email).toEqual([EMAIL_IN_USE_MESSAGE]);

    const gone = await invitePending("gone@studio.test");
    const ctx = await contextFor(db, ids.users.owner);
    await withTx((tx) => deactivateUser(tx, ctx, { userId: gone.userId, expectedVersion: 1 }), { db });
    expect(details(await fail({ ...GOOD, email: "gone@studio.test" })).fieldErrors.email).toEqual([EMAIL_IN_USE_MESSAGE]);
    await withTx((tx) => anonymiseUser(tx, ctx, { userId: gone.userId, expectedVersion: 2 }), { db });
    // Anonymising frees the address.
    await expect(signUp(db, { ...GOOD, email: "gone@studio.test", ip: "2.2.2.2" })).resolves.toMatchObject({ email: "gone@studio.test" });
  });
});
