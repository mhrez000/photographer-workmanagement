/**
 * Small Zod building blocks shared by the admin / structure schemas
 * (users, teams, clients, projects, settings, workflow, views).
 */
import { z } from "zod";

/** Row id (nanoid, or deterministic fixture ids in tests). */
export const IdSchema = z.string().trim().min(1, "Required").max(64);

/** Optimistic concurrency token; optional on admin rows (enforced when sent). */
export const ExpectedVersionSchema = z.number().int().min(1).optional();

/** `#rrggbb` colour. */
export const HexColourSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #3b82f6")
  .transform((v) => v.toLowerCase());

/** Required single-line name. */
export const NameSchema = (max = 120) => z.string().trim().min(1, "Required").max(max);

/** Optional free text: blank strings become null. */
export const OptionalTextSchema = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v === null || v.length === 0 ? null : v));

/** Optional email: blank → null; lower-cased. */
export const OptionalEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .nullish()
  .transform((v) => (v === undefined ? undefined : v === null || v.length === 0 ? null : v))
  .refine((v) => v === undefined || v === null || z.email().safeParse(v).success, "Enter a valid email address");

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar date picked in the UI (`YYYY-MM-DD`, stored as end of that day in
 * the org timezone by the service) or an ISO instant (stored as-is, normalised).
 */
export const CalendarDateSchema = z
  .string()
  .trim()
  .refine((v) => CIVIL_DATE.test(v) || !Number.isNaN(Date.parse(v)), "Enter a valid date")
  .nullish();

export function isCivilDate(value: string): boolean {
  return CIVIL_DATE.test(value);
}

/** Requires at least one key besides the listed identity keys. */
export function hasChanges(value: Record<string, unknown>, identityKeys: readonly string[]): boolean {
  return Object.entries(value).some(([k, v]) => !identityKeys.includes(k) && v !== undefined);
}
