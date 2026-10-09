/** Zod schemas for authentication inputs (login, change password). */
import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

export const EmailSchema = z
  .string({ error: "Enter your email address" })
  .trim()
  .toLowerCase()
  .min(1, "Enter your email address")
  .max(254)
  .pipe(z.email("Enter a valid email address"));

export const LoginInput = z.object({
  email: EmailSchema,
  password: z.string({ error: "Enter your password" }).min(1, "Enter your password").max(PASSWORD_MAX_LENGTH),
  ip: z.string().max(100).nullish(),
  userAgent: z.string().max(500).nullish(),
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
