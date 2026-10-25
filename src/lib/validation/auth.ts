/**
 * Zod schemas for authentication inputs: login, change password, the front door (sign-up, forgot / reset
 * password, invite acceptance) and accounts (email confirmation, email change, set password, demo sign-in,
 * Google sign-in — docs/ACCOUNTS-PLAN.md §2).
 */
import { z } from "zod";
import { DEMO_PERSONAS, GOOGLE_INTENTS, SLUG_MAX_LENGTH, SLUG_PATTERN, STUDIO_NAME_MAX_LENGTH, STUDIO_NAME_MIN_LENGTH } from "@/lib/constants";

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

/**
 * The sign-up honeypot (`SIGNUP_HONEYPOT_FIELD` = "website"): a hidden field people never fill in. Accepted by the
 * schema (so a bot gets the SAME generic 400 the service gives, not a tell-tale "unknown field"); any non-empty
 * value is refused by the service.
 */
export const HoneypotSchema = z.string().max(2000).optional();

/** POST /api/auth/signup — "Create your studio". */
export const SignUpInput = z.strictObject({
  ownerName: z.string({ error: "Enter your name" }).trim().min(1, "Enter your name").max(120),
  email: EmailSchema,
  password: NewPasswordSchema,
  studioName: StudioNameSchema,
  timezone: TimezoneSchema.optional(),
  website: HoneypotSchema,
  ...RequestMetaSchema,
});
export type SignUpInput = z.infer<typeof SignUpInput>;

/** POST /api/auth/forgot-password. */
export const ForgotPasswordInput = z.strictObject({
  email: EmailSchema,
  ...RequestMetaSchema,
});
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordInput>;

/**
 * Mail clients and chat apps encode a trailing space as `%20` (and some paste the link percent-encoded);
 * Next hands a dynamic segment over still encoded. Decode once (never throwing) and trim, so the same
 * mistake is forgiven on the invite page, the reset page and the API alike.
 */
export function cleanToken(raw: string): string {
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // Not percent-encoded (or malformed): the regex below rejects it as it is.
  }
  return value.trim();
}

/** A one-time token from an invite / reset link (base64url, 43 chars for 32 random bytes; bounds are generous). */
export const TokenSchema = z.preprocess(
  (v) => (typeof v === "string" ? cleanToken(v) : v),
  z
    .string({ error: "This link is not valid" })
    .min(16, "This link is not valid")
    .max(128, "This link is not valid")
    .regex(/^[A-Za-z0-9_-]+$/, "This link is not valid"),
);

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

/* ------------------------------------------------------------------ */
/*  Accounts (docs/ACCOUNTS-PLAN.md §2)                                */
/* ------------------------------------------------------------------ */

/** POST /api/auth/verify-email — the button on /verify-email. */
export const VerifyEmailInput = z.strictObject({ token: TokenSchema, ...RequestMetaSchema });
export type VerifyEmailInput = z.infer<typeof VerifyEmailInput>;

/** POST /api/auth/email-change — new address + the current password. */
export const ChangeEmailInput = z.strictObject({
  newEmail: EmailSchema,
  password: z.string({ error: "Enter your current password" }).min(1, "Enter your current password").max(PASSWORD_MAX_LENGTH),
  ...RequestMetaSchema,
});
export type ChangeEmailInput = z.infer<typeof ChangeEmailInput>;

/** POST /api/auth/email-change/confirm — the button on /change-email. */
export const ConfirmEmailChangeInput = z.strictObject({ token: TokenSchema, ...RequestMetaSchema });
export type ConfirmEmailChangeInput = z.infer<typeof ConfirmEmailChangeInput>;

/** POST /api/auth/set-password — a first password for an account that has none (Google sign-ups). */
export const SetPasswordInput = z.strictObject({ password: NewPasswordSchema, ...RequestMetaSchema });
export type SetPasswordInput = z.infer<typeof SetPasswordInput>;

/**
 * POST /api/auth/google/connect — "Connect Google" on My account asks for the current password first (SEC-03: a new
 * way in must never be added by whoever happens to be at an unlocked computer).
 */
export const GoogleConnectInput = z.strictObject({
  password: z.string({ error: "Enter your current password" }).min(1, "Enter your current password").max(PASSWORD_MAX_LENGTH),
  ...RequestMetaSchema,
});
export type GoogleConnectInput = z.infer<typeof GoogleConnectInput>;

/** POST /api/auth/demo — one of the "Look around the demo" persona buttons. */
export const DemoSignInInput = z.strictObject({
  persona: z.enum(DEMO_PERSONAS, { error: "Choose who to look around as" }),
  ...RequestMetaSchema,
});
export type DemoSignInInput = z.infer<typeof DemoSignInInput>;

/** GET /api/auth/google/start?intent&invite&next (query string → object). */
export const GoogleStartInput = z.object({
  intent: z.enum(GOOGLE_INTENTS).default("signin"),
  invite: TokenSchema.optional(),
  /** Sanitised with `safeNextPath` before use. */
  next: z.string().max(2000).optional(),
});
export type GoogleStartInput = z.infer<typeof GoogleStartInput>;

/** POST /api/auth/google/complete — /signup/google's form (the verified Google identity is in the signed cookie). */
export const GoogleCompleteInput = z.strictObject({
  studioName: StudioNameSchema,
  ownerName: z.string().trim().min(1, "Enter your name").max(120).optional(),
  timezone: TimezoneSchema.optional(),
  website: HoneypotSchema,
  ...RequestMetaSchema,
});
export type GoogleCompleteInput = z.infer<typeof GoogleCompleteInput>;
