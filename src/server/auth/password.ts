/**
 * Password hashing (bcryptjs, cost BCRYPT_COST = 12) and temporary
 * passwords for invites / resets. Never log or audit plaintext or hashes.
 */
import { compare, hash } from "bcryptjs";
import { randomInt } from "node:crypto";
import { BCRYPT_COST } from "@/lib/constants";

export async function hashPassword(plain: string, cost: number = BCRYPT_COST): Promise<string> {
  return hash(plain, cost);
}

/** Constant-time compare via bcrypt. Returns false for malformed hashes. */
export async function verifyPassword(plain: string, passwordHash: string): Promise<boolean> {
  try {
    return await compare(plain, passwordHash);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Burns the same bcrypt work as a real check when the email is unknown, so
 * response time does not reveal whether an account exists.
 */
export async function verifyAgainstDummy(plain: string): Promise<false> {
  dummyHash ??= hash("dummy-password-for-timing", BCRYPT_COST);
  await compare(plain, await dummyHash);
  return false;
}

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%*?";
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

/**
 * Cryptographically random temporary password (default 14 chars) with at
 * least one lowercase, uppercase, digit and symbol; ambiguous glyphs
 * (0/O, 1/l/I) excluded so it can be read out loud.
 */
export function generateTempPassword(length = 14): string {
  const size = Math.max(length, 8);
  const pickFrom = (alphabet: string) => alphabet[randomInt(alphabet.length)];
  const chars = [pickFrom(LOWER), pickFrom(UPPER), pickFrom(DIGITS), pickFrom(SYMBOLS)];
  while (chars.length < size) chars.push(pickFrom(ALL));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
