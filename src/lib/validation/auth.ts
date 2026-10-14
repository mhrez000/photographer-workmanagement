/**
 * Zod schemas for authentication inputs: login, change password, and the front door
 * (sign-up, forgot / reset password, invite acceptance).
 */
import { z } from "zod";
import { SLUG_MAX_LENGTH, SLUG_PATTERN, STUDIO_NAME_MAX_LENGTH, STUDIO_NAME_MIN_LENGTH } from "@/lib/constants";

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

export const EmailSchema = z
  .string({ error: "Enter your email address" })
  .trim()
  .toLowerCase()
  .min(1, "Enter your email address")
  .max(254)
  .pipe(z.email("Enter a valid email address"));

const RequestMetaSchema = {
  ip: z.string().max(100).nullish(),
  userAgent: z.string().max(500).nullish(),
};

export const LoginInput = z.object({
  email: EmailSchema,
  password: z.string({ error: "Enter your password" }).min(1, "Enter your password").max(PASSWORD_MAX_LENGTH),
  ...RequestMetaSchema,
});
export type LoginInput = z.infer<typeof LoginInput>;

/** New passwords: length-based policy (NIST 800-63B style), no edge whitespace. */
export const NewPasswordSchema = z
  .string({ error: "Enter a new password" })
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((v) => v.trim().length === v.length, "Remove leading or trailing spaces");

export const ChangePasswordInput = z
  .object({
    current: z.string({ error: "Enter your current password" }).min(1, "Enter your current password").max(PASSWORD_MAX_LENGTH),
    next: NewPasswordSchema,
  })
  .refine((v) => v.current !== v.next, { path: ["next"], message: "Choose a password different from the current one" });
export type ChangePasswordInput = z.infer<typeof ChangePasswordInput>;

/* ------------------------------------------------------------------ */
/*  Front door                                                         */
/* ------------------------------------------------------------------ */

/** An IANA timezone the runtime knows (`Intl`), e.g. "Australia/Sydney". */
export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const TimezoneSchema = z.string().trim().min(1).max(64).refine(isValidTimezone, "Choose a valid timezone");

/** Studio (organisation) name: 2–80 characters. */
export const StudioNameSchema = z
  .string({ error: "Enter your studio name" })
  .trim()
  .min(STUDIO_NAME_MIN_LENGTH, `Use at least ${STUDIO_NAME_MIN_LENGTH} characters`)
  .max(STUDIO_NAME_MAX_LENGTH, `Use at most ${STUDIO_NAME_MAX_LENGTH} characters`);

/** organisations.slug (optional on sign-up; derived from the studio name when omitted). */
export const SlugSchema = z.string().trim().toLowerCase().min(1).max(SLUG_MAX_LENGTH).regex(SLUG_PATTERN, "Use lower-case letters, digits and hyphens");

/** POST /api/auth/signup — "Create your studio". */
export const SignUpInput = z.strictObject({
  ownerName: z.string({ error: "Enter your name" }).trim().min(1, "Enter your name").max(120),
  email: EmailSchema,
  password: NewPasswordSchema,
  studioName: StudioNameSchema,
  timezone: TimezoneSchema.optional(),
  ...RequestMetaSchema,
});
export type SignUpInput = z.infer<typeof SignUpInput>;

/** POST /api/auth/forgot-password. */
export const ForgotPasswordInput = z.strictObject({
  email: EmailSchema,
  ...RequestMetaSchema,
});
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordInput>;

/** A one-time token from an invite / reset link (base64url, 43 chars for 32 random bytes; bounds are generous). */
export const TokenSchema = z
  .string({ error: "This link is not valid" })
  .trim()
  .min(16, "This link is not valid")
  .max(128, "This link is not valid")
  .regex(/^[A-Za-z0-9_-]+$/, "This link is not valid");

/** POST /api/auth/reset-password. */
export const ResetPasswordInput = z.strictObject({
  token: TokenSchema,
  password: NewPasswordSchema,
  ...RequestMetaSchema,
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordInput>;

/** POST /api/auth/invite/:token/accept — set a password (and optionally correct the name) to join. */
export const AcceptInviteInput = z.strictObject({
  token: TokenSchema,
  name: z.string().trim().min(1, "Enter your name").max(120).optional(),
  password: NewPasswordSchema,
  ...RequestMetaSchema,
});
export type AcceptInviteInput = z.infer<typeof AcceptInviteInput>;

/** GET /api/auth/invite/:token. */
export const InviteTokenInput = z.strictObject({ token: TokenSchema });
export type InviteTokenInput = z.infer<typeof InviteTokenInput>;

/** POST /api/users/:id/invite/resend · /revoke. */
export const InviteTargetInput = z.strictObject({ userId: z.string().trim().min(1).max(64) });
export type InviteTargetInput = z.infer<typeof InviteTargetInput>;
