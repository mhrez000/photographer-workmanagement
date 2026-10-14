/**
 * One-time link tokens (invite acceptance, password reset) over the `auth_tokens` ledger.
 *
 * - the plain token (32 random bytes, base64url) is returned ONCE to the caller and never stored, logged or
 *   audited; only `sha256(token)` (hex) is kept, so a database read cannot be replayed as a link
 * - a token is LIVE while `used_at IS NULL AND expires_at > now`; `used_at` is fill-once (trigger `at_fill_once`)
 *   and means "consumed": accepted / reset, or superseded by a newer token / revoked by an admin
 * - one live token per (user, kind): issuing a new one consumes the older ones in the same transaction
 *
 * Pure DB helpers: permission checks and audit events belong to the services that call them
 * (src/server/services/{invites,passwordReset,users}.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { first, type DbLike, type Tx } from "@/db/index";
import { authTokens } from "@/db/schema";
import { INVITE_TTL_HOURS, RESET_TTL_MINUTES, type AuthTokenKind } from "@/lib/constants";
import type { AuthToken } from "@/lib/types";

/** URL-safe random token (43 chars). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256 hex of a plain token — what `auth_tokens.token_hash` stores. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** ISO expiry for a kind, from `now`. */
export function tokenExpiry(kind: AuthTokenKind, nowIso: string): string {
  const ms = kind === "invite" ? INVITE_TTL_HOURS * 60 * 60_000 : RESET_TTL_MINUTES * 60_000;
  return new Date(Date.parse(nowIso) + ms).toISOString();
}

export interface IssuedToken {
  /** The plain token — show or email it once, then forget it. */
  token: string;
  tokenId: string;
  expiresAt: string;
  /** How many older live tokens of the same kind were consumed (superseded). */
  superseded: number;
}

/**
 * Consumes every live token of `kind` for the user (fill-once `used_at = now`) and inserts a fresh one.
 * Returns the plain token once.
 */
export async function issueToken(
  tx: Tx,
  input: { organisationId: string; userId: string; kind: AuthTokenKind; createdByUserId: string | null; now: string },
): Promise<IssuedToken> {
  const superseded = await consumeLiveTokens(tx, input.userId, input.kind, input.now);
  const token = generateToken();
  const expiresAt = tokenExpiry(input.kind, input.now);
  const [row] = await tx
    .insert(authTokens)
    .values({
      organisationId: input.organisationId,
      userId: input.userId,
      kind: input.kind,
      tokenHash: hashToken(token),
      createdByUserId: input.createdByUserId,
      expiresAt,
      createdAt: input.now,
    })
    .returning({ id: authTokens.id });
  return { token, tokenId: row.id, expiresAt, superseded };
}

/** Marks every live token of `kind` for the user as used (superseded / revoked). Returns how many. */
export async function consumeLiveTokens(tx: Tx, userId: string, kind: AuthTokenKind, now: string): Promise<number> {
  const rows = await tx
    .update(authTokens)
    .set({ usedAt: now })
    .where(and(eq(authTokens.userId, userId), eq(authTokens.kind, kind), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)))
    .returning({ id: authTokens.id });
  return rows.length;
}

/** The live token row matching a plain token (right kind, unused, unexpired), or null. */
export async function findLiveToken(db: DbLike, token: string, kind: AuthTokenKind, now: string): Promise<AuthToken | null> {
  const row = await first(
    db
      .select()
      .from(authTokens)
      .where(and(eq(authTokens.tokenHash, hashToken(token)), eq(authTokens.kind, kind), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now))),
  );
  return row ?? null;
}

/** Fill-once: marks one token used. Returns false when it was already consumed (lost race). */
export async function markTokenUsed(tx: Tx, tokenId: string, now: string): Promise<boolean> {
  const rows = await tx
    .update(authTokens)
    .set({ usedAt: now })
    .where(and(eq(authTokens.id, tokenId), isNull(authTokens.usedAt)))
    .returning({ id: authTokens.id });
  return rows.length === 1;
}

/** Live tokens of a kind for a user (admin screens: "invite pending, expires …"). */
export async function liveTokensFor(db: DbLike, userId: string, kind: AuthTokenKind, now: string): Promise<AuthToken[]> {
  return db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.userId, userId), eq(authTokens.kind, kind), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)))
    .orderBy(authTokens.createdAt);
}

/** A password hash no password can match (bcrypt `compare` returns false for it): invited users until they accept. */
export function unusablePasswordHash(): string {
  return `!invite!${randomBytes(24).toString("base64url")}`;
}
