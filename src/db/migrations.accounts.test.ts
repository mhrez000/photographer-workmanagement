/**
 * Accounts migrations (drizzle/0006_accounts.sql generated + drizzle/0007_accounts_data.sql custom +
 * drizzle/0008_accounts_hardening.sql custom — the review fixes; docs/ACCOUNTS-PLAN.md §1, §8). Boots PGlite at migration 0005 (the front-door schema), inserts live-like data — the
 * seeded demo studios, a real sign-up that happens to look similar, a pending invitee, an anonymised person,
 * live invite / reset links — applies the rest and asserts the backfills, the CHECKs and the re-run guard.
 * Additive only: no row disappears.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "./schema";
import { execRows, migrationsFolder, PGLITE_PARSERS } from "./index";
import { rootErrorMessage } from "./errors";
import { verifyDerived } from "./verify";

const opened: PGlite[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => (c.closed ? Promise.resolve() : c.close())));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A migrations folder holding only the first `count` committed migrations. */
function partialMigrationsFolder(count: number): string {
  const src = migrationsFolder();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pwm-accounts-"));
  tempDirs.push(dir);
  const journal = JSON.parse(fs.readFileSync(path.join(src, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const entries = journal.entries.filter((e) => e.idx < count);
  fs.mkdirSync(path.join(dir, "meta"));
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }, null, 2));
  for (const e of entries) fs.copyFileSync(path.join(src, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

/** The database as production has it before accounts: migrations 0000–0005. */
async function frontDoorDatabase() {
  const client = await PGlite.create({ parsers: PGLITE_PARSERS });
  opened.push(client);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: partialMigrationsFolder(6) });
  return { client, db };
}

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-02-01T00:00:00.000Z";
const BCRYPT = "$2b$10$abcdefghijklmnopqrstuvC0123456789012345678901234567890";

type Q = { query: (text: string, params?: unknown[]) => Promise<unknown> };

async function insertOrg(c: Q, id: string, slug: string) {
  await c.query(`INSERT INTO organisations (id, name, slug, created_at, updated_at) VALUES ($1, $1, $2, $3, $3)`, [id, slug, T0]);
}

async function insertUser(c: Q, id: string, org: string, email: string, opts: { hash?: string; acceptedAt?: string | null; anonymised?: boolean } = {}) {
  await c.query(
    `INSERT INTO users (id, organisation_id, email, password_hash, name, role, is_admin, accepted_at, anonymised_at, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $1, 'photographer', false, $5, $6, $7, $8, $8)`,
    [id, org, email, opts.hash ?? BCRYPT, opts.acceptedAt === undefined ? T1 : opts.acceptedAt, opts.anonymised ? T1 : null, !opts.anonymised, T0],
  );
}

async function insertToken(c: Q, id: string, org: string, user: string, kind: string) {
  await c.query(
    `INSERT INTO auth_tokens (id, organisation_id, user_id, kind, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, org, user, kind, id.padEnd(64, "0"), "2099-01-01T00:00:00.000Z", T0],
  );
}

describe("0006 + 0007 + 0008 accounts migrations", () => {
  it("backfills confirmation, has_password and the demo flag; adds the CHECKs; deletes nothing", async () => {
    const { client, db } = await frontDoorDatabase();
    // the seeded demo studios
    await insertOrg(client, "nl", "northlight");
    await insertUser(client, "nl-owner", "nl", "owner@studio.test");
    await insertOrg(client, "os", "other-studio");
    await insertUser(client, "os-owner", "os", "owner@other.test");
    // a real studio with a demo-like slug but real people → never flagged
    await insertOrg(client, "real", "northlight-2");
    await insertUser(client, "real-owner", "real", "mo@northlight.example");
    await insertOrg(client, "fake", "other-studio-x");
    await insertUser(client, "fake-owner", "fake", "owner@other.test.example");
    // a pending link-invitee, an anonymised person, a temp-password person accepted later
    await insertUser(client, "pending", "real", "new@northlight.example", { hash: "!invite!abc", acceptedAt: null });
    await insertUser(client, "gone", "real", "anon-gone@invalid", { hash: "!anonymised!xyz", anonymised: true });
    await insertToken(client, "tok-invite", "real", "pending", "invite");
    await insertToken(client, "tok-reset", "real", "real-owner", "password_reset");
    const countBefore = await execRows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM users`);

    await migrate(db, { migrationsFolder: migrationsFolder() });

    const users = await execRows<{ id: string; email_verified_at: string | null; has_password: boolean; google_sub: string | null }>(
      db,
      sql`SELECT id, email_verified_at, has_password, google_sub FROM users ORDER BY id`,
    );
    const byId = new Map(users.map((u) => [u.id, u]));
    expect(users).toHaveLength(countBefore[0].n);
    // (a) everyone existing who has joined is confirmed (accepted_at); 0008 (e): somebody who has NOT joined yet is not
    //     (opening an invite link proves nothing on its own — SEC-05)
    expect(byId.get("real-owner")?.email_verified_at).toBe(T1);
    expect(byId.get("pending")?.email_verified_at).toBeNull();
    expect(users.filter((u) => u.id !== "pending").every((u) => u.email_verified_at !== null)).toBe(true);
    // (b) has_password follows the hash
    expect(byId.get("real-owner")?.has_password).toBe(true);
    expect(byId.get("pending")?.has_password).toBe(false);
    expect(byId.get("gone")?.has_password).toBe(false);
    expect(users.every((u) => u.google_sub === null)).toBe(true);
    // (c) demo flag: only the seeded studios
    const orgs = await execRows<{ id: string; is_demo: boolean }>(db, sql`SELECT id, is_demo FROM organisations ORDER BY id`);
    expect(Object.fromEntries(orgs.map((o) => [o.id, o.is_demo]))).toEqual({ fake: false, nl: true, os: true, real: false });
    // tokens untouched, new column null
    const tokens = await execRows<{ id: string; target_email: string | null; used_at: string | null }>(db, sql`SELECT id, target_email, used_at FROM auth_tokens ORDER BY id`);
    expect(tokens).toEqual([
      { id: "tok-invite", target_email: null, used_at: null },
      { id: "tok-reset", target_email: null, used_at: null },
    ]);
    // (d) CHECKs
    const reject = async (text: string) => {
      try {
        await client.query(text);
      } catch (err) {
        return rootErrorMessage(err);
      }
      throw new Error(`expected rejection: ${text}`);
    };
    expect(await reject(`INSERT INTO auth_tokens (id, organisation_id, user_id, kind, token_hash, expires_at, created_at) VALUES ('x1', 'real', 'real-owner', 'email_verify', '${"c".repeat(64)}', '${T1}', '${T1}')`)).toMatch(
      /auth_tokens_target_email_ck/,
    );
    expect(await reject(`INSERT INTO auth_tokens (id, organisation_id, user_id, kind, token_hash, expires_at, created_at) VALUES ('x2', 'real', 'real-owner', 'magic', '${"d".repeat(64)}', '${T1}', '${T1}')`)).toMatch(
      /auth_tokens_kind_ck/,
    );
    expect(await reject(`UPDATE users SET google_sub = 'g1' WHERE id = 'real-owner'`)).toMatch(/users_google_pair_ck/);
    await client.query(`UPDATE users SET google_sub = 'g1', google_email = 'mo@gmail.test' WHERE id = 'real-owner'`);
    expect(await reject(`UPDATE users SET google_sub = 'g1', google_email = 'x@gmail.test' WHERE id = 'pending'`)).toMatch(/users_google_sub_uq|duplicate key/);
    // (e) target_email is immutable once written
    await client.query(
      `INSERT INTO auth_tokens (id, organisation_id, user_id, kind, token_hash, target_email, expires_at, created_at) VALUES ('ok1', 'real', 'real-owner', 'email_change', '${"e".repeat(64)}', 'mo@new.test', '${T1}', '${T1}')`,
    );
    expect(await reject(`UPDATE auth_tokens SET target_email = 'evil@x.test' WHERE id = 'ok1'`)).toMatch(/immutable/);
    await client.query(`UPDATE auth_tokens SET used_at = '${T1}' WHERE id = 'ok1'`);

    expect((await verifyDerived(db)).drift).toEqual([]);
  }, 60_000);

  it("0008: demo studios' live invite links are used up; has_password follows the hash; a used link's address can be scrubbed, nothing else", async () => {
    const { client, db } = await frontDoorDatabase();
    await insertOrg(client, "nl", "northlight");
    await insertUser(client, "nl-owner", "nl", "owner@studio.test");
    await insertUser(client, "nl-visitor", "nl", "visitor-invite@gmail.example", { hash: "!invite!v", acceptedAt: null });
    await insertToken(client, "tok-demo-invite", "nl", "nl-visitor", "invite");
    await insertOrg(client, "real", "real-studio");
    await insertUser(client, "real-owner", "real", "mo@real.example");
    await insertUser(client, "real-pending", "real", "new@real.example", { hash: "!invite!r", acceptedAt: null });
    await insertToken(client, "tok-real-invite", "real", "real-pending", "invite");
    // Applied 0006 + 0007 first (as an environment that already has them), then old code wrote a drifted row.
    await migrate(db, { migrationsFolder: partialMigrationsFolder(8) });
    await client.query(`UPDATE users SET has_password = true WHERE id = 'real-pending'`);
    await client.query(`UPDATE users SET has_password = false WHERE id = 'real-owner'`);

    await migrate(db, { migrationsFolder: migrationsFolder() });

    const tokens = await execRows<{ id: string; used_at: string | null }>(db, sql`SELECT id, used_at FROM auth_tokens ORDER BY id`);
    const usedAt = Object.fromEntries(tokens.map((t) => [t.id, t.used_at]));
    expect(usedAt["tok-demo-invite"]).not.toBeNull();
    expect(usedAt["tok-real-invite"]).toBeNull();
    const flags = await execRows<{ id: string; has_password: boolean }>(db, sql`SELECT id, has_password FROM users ORDER BY id`);
    expect(Object.fromEntries(flags.map((u) => [u.id, u.has_password]))).toMatchObject({ "real-pending": false, "real-owner": true, "nl-visitor": false });

    const reject = async (text: string) => {
      try {
        await client.query(text);
      } catch (err) {
        return rootErrorMessage(err);
      }
      throw new Error(`expected rejection: ${text}`);
    };
    const insertChange = (id: string, hash: string) =>
      client.query(
        `INSERT INTO auth_tokens (id, organisation_id, user_id, kind, token_hash, target_email, expires_at, created_at) VALUES ('${id}', 'real', 'real-owner', 'email_change', '${hash.repeat(64)}', 'private@personal.example', '2099-01-01T00:00:00.000Z', '${T1}')`,
      );
    await insertChange("chg-live", "a");
    await insertChange("chg-used", "b");
    await client.query(`UPDATE auth_tokens SET used_at = '${T1}' WHERE id = 'chg-used'`);
    // an unused link keeps its address (CHECK) and never changes it (guard)
    expect(await reject(`UPDATE auth_tokens SET target_email = NULL WHERE id = 'chg-live'`)).toMatch(/immutable|auth_tokens_target_email_ck/);
    expect(await reject(`UPDATE auth_tokens SET target_email = 'evil@x.test' WHERE id = 'chg-live'`)).toMatch(/immutable/);
    // a used row: the one-way scrub only — never another address, never a new used_at, never a no-op rewrite
    expect(await reject(`UPDATE auth_tokens SET target_email = 'evil@x.test' WHERE id = 'chg-used'`)).toMatch(/immutable/);
    expect(await reject(`UPDATE auth_tokens SET used_at = '2026-03-01T00:00:00.000Z' WHERE id = 'chg-used'`)).toMatch(/immutable/);
    expect(await reject(`UPDATE auth_tokens SET used_at = used_at WHERE id = 'chg-used'`)).toMatch(/immutable/);
    await client.query(`UPDATE auth_tokens SET target_email = NULL WHERE id = 'chg-used'`);
    // using up and scrubbing in one statement (what anonymising does)
    await client.query(`UPDATE auth_tokens SET used_at = '${T1}', target_email = NULL WHERE id = 'chg-live'`);
    const scrubbed = await execRows<{ id: string; target_email: string | null }>(db, sql`SELECT id, target_email FROM auth_tokens WHERE kind = 'email_change' ORDER BY id`);
    expect(scrubbed).toEqual([
      { id: "chg-live", target_email: null },
      { id: "chg-used", target_email: null },
    ]);
    // still no delete, and an unused email link still needs its address
    expect(await reject(`DELETE FROM auth_tokens WHERE id = 'chg-used'`)).toMatch(/.+/);
    expect(await reject(`INSERT INTO auth_tokens (id, organisation_id, user_id, kind, token_hash, expires_at, created_at) VALUES ('x9', 'real', 'real-owner', 'email_verify', '${"9".repeat(64)}', '${T1}', '${T1}')`)).toMatch(
      /auth_tokens_target_email_ck/,
    );

    // Re-running 0008 by hand changes nothing more.
    const before = await execRows<{ n: string }>(db, sql`SELECT md5(string_agg(id || coalesce(used_at, '-'), ',' ORDER BY id)) AS n FROM auth_tokens`);
    const text = fs.readFileSync(path.join(migrationsFolder(), "0008_accounts_hardening.sql"), "utf8");
    for (const statement of text.split("--> statement-breakpoint")) if (statement.trim()) await client.exec(statement);
    const after = await execRows<{ n: string }>(db, sql`SELECT md5(string_agg(id || coalesce(used_at, '-'), ',' ORDER BY id)) AS n FROM auth_tokens`);
    expect(after).toEqual(before);
    expect((await verifyDerived(db)).drift).toEqual([]);
  }, 60_000);

  it("the confirmation backfill is a no-op once the feature has issued a link (re-run guard)", async () => {
    const { client, db } = await frontDoorDatabase();
    await migrate(db, { migrationsFolder: migrationsFolder() });
    await insertOrg(client, "o", "studio-o");
    await insertUser(client, "new-owner", "o", "new@studio-o.example");
    await client.query(
      `INSERT INTO auth_tokens (id, organisation_id, user_id, kind, token_hash, target_email, expires_at, created_at) VALUES ('v1', 'o', 'new-owner', 'email_verify', '${"f".repeat(64)}', 'new@studio-o.example', '${T1}', '${T1}')`,
    );
    // Re-running 0007 by hand must leave the new (unconfirmed) sign-up alone.
    const text = fs.readFileSync(path.join(migrationsFolder(), "0007_accounts_data.sql"), "utf8");
    for (const statement of text.split("--> statement-breakpoint")) if (statement.trim()) await client.exec(statement);
    const [row] = await execRows<{ email_verified_at: string | null }>(db, sql`SELECT email_verified_at FROM users WHERE id = 'new-owner'`);
    expect(row.email_verified_at).toBeNull();
  }, 60_000);
});
