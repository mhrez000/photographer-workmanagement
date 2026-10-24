/**
 * Known devices (SEC-06, docs/ACCOUNTS.md §6 "Rate limits"). Every real sign-in (password, Google, accepting an invite,
 * a password reset, creating a studio — never the shared demo personas) leaves a signed, httpOnly cookie
 * (`KNOWN_DEVICE_COOKIE`, 180 days) saying "this browser has signed in to <address> before". It carries a random
 * device id and a keyed hash of the address (never the address itself).
 *
 * The sign-in limiter (src/server/auth/db-rate-limit.ts) treats such a browser differently: its failed attempts count
 * under its OWN key (5 per 15 min) instead of the per-email backstop (20 per 15 min from anywhere) — so strangers
 * guessing passwords from many addresses can fill the backstop, but never lock the owner out of a browser they already
 * use. A stolen cookie is no help to a guesser: it only grants a fresh count of five, and it is bound to one address.
 * Signing out keeps it (the browser is still known); it is replaced by the next sign-in.
 *
 *   rememberThisDevice(email)            route handlers / server actions: (re)sets the cookie
 *   currentKnownDevice()                 the cookie's claims (or null)
 *   knownDeviceIdFor(device, email)      the device id when the cookie is for this address, else null
 *
 * (Pure helpers + two cookie helpers; no database.)
 */
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { KNOWN_DEVICE_COOKIE, KNOWN_DEVICE_TTL_DAYS } from "@/lib/constants";
import { keyedHash, signPurposeToken, verifyPurposeToken } from "./session-token";

const PURPOSE = "known_device";
export const KNOWN_DEVICE_TTL_SECONDS = KNOWN_DEVICE_TTL_DAYS * 24 * 60 * 60;

export interface KnownDevice {
  /** Random per-browser id (the limiter's key). */
  id: string;
  /** keyedHash of the normalised address it signed in to. */
  tag: string;
}

function addressTag(email: string): string {
  return keyedHash(PURPOSE, email.trim().toLowerCase());
}

/** The signed cookie value for `email` (a fresh device id unless one is given). */
export async function knownDeviceToken(email: string, deviceId: string = randomBytes(16).toString("base64url")): Promise<string> {
  return signPurposeToken({ d: deviceId, e: addressTag(email) }, PURPOSE, KNOWN_DEVICE_TTL_SECONDS);
}

/** The claims of a known-device cookie value, or null (missing, expired, tampered, another purpose). */
export async function readKnownDevice(token: string | null | undefined): Promise<KnownDevice | null> {
  const claims = await verifyPurposeToken<Record<string, unknown>>(token, PURPOSE);
  const id = claims?.d;
  const tag = claims?.e;
  if (typeof id !== "string" || id.length < 8 || id.length > 64 || typeof tag !== "string" || tag.length !== 64) return null;
  return { id, tag };
}

/** The device id when `device` signed in to `email` before; null otherwise. */
export function knownDeviceIdFor(device: KnownDevice | null | undefined, email: string): string | null {
  if (!device) return null;
  return device.tag === addressTag(email) ? device.id : null;
}

export function knownDeviceCookieOptions(maxAge: number = KNOWN_DEVICE_TTL_SECONDS) {
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge };
}

/** This browser's known-device cookie (route handlers / server actions / server components). */
export async function currentKnownDevice(): Promise<KnownDevice | null> {
  const jar = await cookies();
  return readKnownDevice(jar.get(KNOWN_DEVICE_COOKIE)?.value);
}

/** Marks this browser as known for `email` (keeps its device id when it already was). Never throws. */
export async function rememberThisDevice(email: string): Promise<void> {
  try {
    const jar = await cookies();
    const existing = await readKnownDevice(jar.get(KNOWN_DEVICE_COOKIE)?.value);
    const value = await knownDeviceToken(email, existing?.id);
    jar.set(KNOWN_DEVICE_COOKIE, value, knownDeviceCookieOptions());
  } catch (err) {
    // A page render (cookies are read-only there) or a test without a cookie jar: being remembered is a nicety.
    console.warn("[known-device] not remembered", err instanceof Error ? err.name : "unknown");
  }
}
