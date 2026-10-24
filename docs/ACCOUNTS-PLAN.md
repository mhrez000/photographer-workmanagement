# Accounts — the build contract (branch `feat/accounts`), AS BUILT

**Status: as-built contract.** The foundation and the four areas (verify, account, google, access) are built,
integrated and green. This file is kept as the record of who built which file and of the shared helpers; where the
build differs from the original plan, **§8 "As built — deviations"** says so (§8 wins over §1–§7). The user-facing
behaviour, env vars and the owner's setup checklist are in `docs/ACCOUNTS.md`; routes in `src/app/api/README.md`.
The lane rules below applied while the areas were built in parallel; they no longer restrict anyone.

User request: "build the full proper sign ups and sign ins, register — basically the full end to end for
users". Sign-up, sign-in, invite links and password reset already exist (PR #4). This completes them.

Rules that do not change (CLAUDE.md): every mutation goes through `src/server/services/*` inside ONE
transaction with `recordEvent` (append-only audit; metadata KEYS matching /password|secret|token/i are
dropped by the redactor — put such words in VALUES, e.g. `via: "set"`); org isolation; plain words (the
users are non-technical photographers, editors and clients — few screens, no jargon); no `any`, no
`console.log`; tokens never stored, logged or audited in plain form; public pages are server components
with one client island; every new segment has `loading.tsx` + `error.tsx`; never run `next dev`,
`db:reset` or `db:seed`; never touch Supabase / `.env.supabase`; do not commit.

Out of scope (documented in docs/ACCOUNTS.md as not built): one email in several studios (emails stay
globally unique), two-factor auth, account / studio deletion, terms / privacy pages, captcha.

---

## 1. Data model (migrations `0006_accounts.sql` generated + `0007_accounts_data.sql` custom + `0008_accounts_hardening.sql` custom — the review fixes, §8)

| Table | Column | Type | Meaning |
|---|---|---|---|
| `organisations` | `is_demo` | `boolean not null default false` | Demo studio. 0007 backfills `true` for the seeded demo orgs (slugs `northlight`, `other-studio` AND a `@studio.test` / `@other.test` member — never a real sign-up). The seed sets it as its LAST step (`markDemoStudios` in `src/db/seed/org.ts`; the seed builds the studio through the real services, which a demo studio refuses). `SEED_DEMO=off` skips it — `e2e/prepare-db.mjs` sets that, so the e2e studio is NOT a demo studio (its specs invite people and reset passwords). |
| `users` | `email_verified_at` | `text null` (ISO) | null = email not confirmed. 0007 backfills `COALESCE(accepted_at, created_at)` for every existing user (they predate the feature) — guarded so a re-run after any `email_verify` / `email_change` token exists is a no-op. Any email change sets it back to null. |
| `users` | `has_password` | `boolean not null default true` | The account has a usable password (bcrypt). false for: link-invitees until they accept with a password, Google-only accounts, anonymised accounts. 0007 backfills `false` where `password_hash NOT LIKE '$2%'`; 0008 re-syncs it both ways. Code that DECIDES something (sign-in, set password, disconnect Google, Connect Google, the overview) uses `hasUsablePassword(user)` = the flag AND a real bcrypt hash (`src/server/auth/password.ts`), so a flag written by older code can never matter (DATA-04). |
| `users` | `google_sub` | `text null`, unique index `users_google_sub_uq` | Google account id (OIDC `sub`). Never exposed through `SafeUser` / `UserProfile`. |
| `users` | `google_email` | `text null` | The Google address shown on "Sign-in methods". CHECK `users_google_pair_ck`: both null or both set. Never exposed through `SafeUser`. |
| `auth_tokens` | `target_email` | `text null` | The address an `email_verify` / `email_change` link was sent to. CHECK `auth_tokens_target_email_ck` (0008): required on an UNUSED email_verify / email_change link, NULL for the other kinds, and may be NULL once the link is used. Immutable except a one-way scrub to NULL on a used row (the fill-once guard, 0008) — what anonymising does (DATA-02). |
| `auth_tokens` | `kind` | + `email_verify`, `email_change` | CHECK `auth_tokens_kind_ck` (4 kinds). |
| `auth_rate_limits` (NEW) | `id, limiter, key_hash, hit_at, expires_at` | text | One row per counted attempt. `key_hash` = HMAC-SHA256 (session secret) of `limiter + ":" + key` (`keyedHash`, DATA-07) — never a raw email / IP, and a copy of the table cannot confirm a guessed address. Not tenant data (no organisation_id), not a ledger (old rows are pruned). Indexes `(limiter, key_hash, hit_at)`, `(expires_at)`. |

Token kinds + TTLs (`AUTH_TOKEN_TTL_MINUTES`): `invite` 7 days · `password_reset` 60 min · `email_verify` 24 h ·
`email_change` 24 h. All: 32 random bytes base64url, sha256 at rest, `used_at` fill-once, one live token per
(user, kind) — issuing supersedes. Links: `/invite/<token>`, `/reset-password?token=`, `/verify-email?token=`,
`/change-email?token=` (`verifyEmailUrl` / `confirmEmailChangeUrl` in `src/server/origin.ts`). Confirm pages
only check the token SHAPE server-side and confirm on a BUTTON PRESS (POST with the token in the body) —
never on GET (mail scanners prefetch links).

## 2. Constants, types, validation (foundation-owned, already in place)

`src/lib/constants.ts`: `AUTH_TOKEN_KINDS` (4), `EMAIL_VERIFY_TTL_HOURS = 24`, `EMAIL_CHANGE_TTL_HOURS = 24`,
`AUTH_TOKEN_TTL_MINUTES`, `TARGET_EMAIL_TOKEN_KINDS`, `SESSION_TTL_DAYS = 30`, `SESSION_RENEW_AFTER_HOURS = 24`,
`RATE_LIMITS` (+ `RateLimiterName`; the old `LOGIN_RATE_LIMIT` / `SIGNUP_RATE_LIMIT` / `PASSWORD_RESET_RATE_LIMIT`
are aliases), `SIGNUP_HONEYPOT_FIELD = "website"`, `DEMO_PERSONAS` / `DemoPersona`, `DEMO_ACCOUNTS` (+ `persona`),
`DEMO_ORG_SLUGS`, `DEMO_SIGN_IN_ENV = "DEMO_SIGN_IN"`, `EMAIL_CONFIRMATION_VIA`, `SIGN_IN_METHODS`,
`GOOGLE_INTENTS`, `GOOGLE_RESULTS`, `GOOGLE_OAUTH_COOKIE` (10 min), `GOOGLE_SIGNUP_COOKIE` (15 min),
`ACCOUNT_SURFACES`. Event types / actions: see §5.

| Limiter (`RATE_LIMITS`) | Policy | Key | Counts |
|---|---|---|---|
| `login` | 5 / 15 min | email + IP | failures (a browser not known for this address) |
| `loginEmail` | 20 / 15 min | email | failures (IP-independent backstop; NOT applied to a known browser — SEC-06) |
| `loginDevice` | 5 / 15 min | email + known-device id | failures from a browser that signed in to that address before (`src/server/auth/known-device.ts`) |
| `loginIp` | 100 / 15 min | IP (only when known) | failures, any address (SEC-09) |
| `signup` | 5 / 60 min | IP (email when no IP) | every attempt (email sign-up AND Google sign-up) |
| `passwordReset` | 5 / 15 min | email + IP | every request |
| `verifyResend` | 5 / 60 min | user id | every resend |
| `emailChange` | 5 / 60 min | user id | every request |
| `passwordCheck` | 10 / 15 min | user id | wrong current password (change password, change email) |
| `googleCallback` | 30 / 15 min | IP (skipped when unknown — SEC-10) | every callback |
| `demoSignIn` | 30 / 10 min | IP (skipped when unknown — SEC-10) | every demo sign-in |
| `resetLink` | 10 / 15 min | IP (skipped when unknown) | reset submits with a dead link |

Test fixtures: `seedMinimalOrg(db, { isDemo?: boolean, emailVerified?: boolean })` (`src/db/test-db.ts`; fixture users
start CONFIRMED unless `emailVerified: false`; the fixture's persona emails `owner@studio.test`, `photographer01@…`,
`editor01@…`, `client@…` match `DEMO_ACCOUNTS`, so `{ isDemo: true }` gives a working demo studio).

`src/lib/types.ts`: `AuthContext.isDemo?: boolean` (absent = false; set by every context builder),
`AccountSecurityOverview`, `AccountBannerState`, `AuthRateLimit`. `SafeUser` / `UserProfile` omit
`googleSub` and `googleEmail`. `Viewer` (session.ts) gains `isDemo`, `emailVerifiedAt`, `hasPassword`.

`src/lib/validation/auth.ts`: `SignUpInput` + `website` (honeypot, optional string), `VerifyEmailInput`
`{ token }`, `ChangeEmailInput` `{ newEmail, password }`, `ConfirmEmailChangeInput` `{ token }`,
`SetPasswordInput` `{ password }`, `DemoSignInInput` `{ persona }`, `GoogleStartInput`
`{ intent, invite?, next? }`, `GoogleCompleteInput` `{ studioName, ownerName?, timezone?, website? }` (all strict,
all + `ip?`, `userAgent?`).

## 3. Shared — foundation-owned code (signatures; read the JSDoc in each file)

| File | Exports |
|---|---|
| `src/server/auth/session-token.ts` | `signSessionToken`, `verifySessionToken` (re-exported by session.ts), `readSessionClaims(token)` → claims + `iat`, `renewSessionToken(token, nowMs?)` → a fresh token when valid AND older than `SESSION_RENEW_AFTER_HOURS`, else null, `sessionCookieOptions(maxAge?)`, `SESSION_TTL_SECONDS`, `signPurposeToken(claims, purpose, ttlSeconds)` / `verifyPurposeToken<T>(token, purpose)` (HS256 with the session secret, `pur` claim; a session token is never a purpose token and vice versa). Imports no DB: safe in `src/proxy.ts`. |
| `src/server/auth/session.ts` | as before + `ctx.isDemo`, `Viewer.isDemo / emailVerifiedAt / hasPassword`. |
| `src/server/auth/sign-in.ts` | `SIGN_IN_REFUSED_MESSAGE` ("Incorrect email or password"), `issueSessionCookie({ id, role, sessionVersion })`, `recordSignIn(tx, ctx, { method, ip?, userAgent?, metadata? })` (stamps `last_login_at`, audits `auth.logged_in` with `metadata.method`; `ctx` = the person's own context), `startSession(db, { userId, method, ip?, userAgent?, requestId?, metadata? })` → `StartedSession` (refuses inactive / anonymised / not-yet-accepted / closed-portal accounts with `UnauthorizedError(SIGN_IN_REFUSED_MESSAGE)`; records the sign-in in its own tx; sets the cookie). Login uses `recordSignIn` + `issueSessionCookie`; invite accept, reset and sign-up use `issueSessionCookie`. Demo sign-in and Google MUST use these (a pending invitee accepts through `completeInviteAcceptance` first, then `issueSessionCookie`). |
| `src/server/auth/demo.ts` | `DEMO_BLOCKED_MESSAGES`, `DemoBlockedAction`, `assertNotDemo(ctx, what)` (throws `ForbiddenError("demo.<what>", plain message)`), `isDemoOrganisation(db, orgId)`, `demoSignInEnabled(env?)`, `findDemoPersonaUser(db, persona)` (active, accepted user with that `DEMO_ACCOUNTS` email in an `is_demo` org — never anyone else), `demoSignInAvailable(db, env?)`, `isDemoPersonaEmail(email)`. |
| `src/server/auth/email-confirmation.ts` | `markEmailConfirmed(tx, ctx, { userId, via })` → true when it changed (stamps `email_verified_at`, consumes live `email_verify` tokens, audits `user.email_confirmed`), `clearEmailConfirmation(tx, { userId, now })` (sets null + consumes live `email_verify` AND `email_change` tokens; the caller's own event records the email change). Already wired: invite accept (`via: "invite"`), password reset (`"reset"`), admin email change (clear). |
| `src/server/auth/db-rate-limit.ts` | `DbRateLimiter` (`check` / `hit` / `reset`, all `(db, key, nowMs?)`), `limiters` (one per `RateLimiterName`), `enforceRateLimit(db, name, key, nowMs?)` (check → 429 `RateLimitedError` or record), key helpers `emailIpKey`, `ipKey`, `userKey`, `signupKey`, login helpers with the OLD names but async + `db` first: `checkLoginAttempt`, `recordLoginAttemptFailure`, `resetLoginAttempts`, `checkSignupAttempt`, `recordSignupAttempt`, `checkPasswordResetRequest`, `recordPasswordResetRequest`, `pruneRateLimits`, `clearAllRateLimits(db)`. Works through the transaction pooler (single statements, no session state); prunes opportunistically. (The old in-memory `rate-limit.ts` is deleted; every caller uses this file.) |
| `src/server/auth/google-config.ts` | `GoogleAuthConfig`, `googleAuthConfig(env?)` → null unless BOTH `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set, `GOOGLE_OIDC` (authorize / token / JWKS URLs, issuers, scope), `googleRedirectUri(req?)` = `${appOrigin(req)}/api/auth/google/callback`. |
| `src/server/auth/tokens.ts` | as before + `issueToken(..., { targetEmail })` (required for `email_verify` / `email_change`), TTL map, `latestLiveToken(db, userId, kind, now)`. |
| `src/server/auth/redirect.ts` | + `safeNextPath(next)` — the exact `next` sanitiser `loginRedirectTarget` uses. Google MUST use it for `next`. |
| `src/server/origin.ts` | + `verifyEmailUrl(token, req?)`, `confirmEmailChangeUrl(token, req?)`. |
| `src/server/email/account.ts` | THE helper for every account email: `sendAccountEmail(db, { userId, to?, content, link?, senderUserId? }, opts?)` → `AccountEmailResult { sent, reason, devLink? }`. Suppresses: demo studio → `"demo"`; email not configured → `"not_configured"`; `senderUserId` given and that user's email unconfirmed → `"unconfirmed_sender"`; provider failure → `"failed"`. `devLink` (= `link`) only outside production and only for `not_configured` / `failed`. `accountEmailBlock(db, { userId, senderUserId? })` = the same decision without sending. Call AFTER the transaction commits. Test seam: `opts.send`, `opts.env`. |
| `src/server/email/templates.ts` | + `confirmEmailEmail`, `confirmNewEmailEmail`, `emailChangedNoticeEmail` (`stage: "requested" \| "changed"`), `passwordChangedNoticeEmail` (`via: "changed" \| "reset" \| "set"`). |
| `src/server/services/accountNotices.ts` | `sendPasswordChangedNotice(db, { userId, via })`, `sendEmailChangedNotice(db, { userId, oldEmail, newEmail, stage })` (to the OLD address). Already wired: change password (`changed`), reset (`reset`). AREA account calls them for set-password and email change. |
| existing services (already changed) | `services/auth.ts`: `changePasswordInDb` and `services/passwordReset.ts` `resetPassword` close any live `email_change` link (a password change cancels a pending email change); `preparePasswordChange` answers a Google-only account (no password) with 400 `fieldErrors.current`; `resetPassword` sets `has_password = true` and confirms the email (`via "reset"`); the reset email goes through `sendAccountEmail` (dev link = `resetUrl`). `services/users.ts`: link invites start with `has_password = false`, temp passwords set it true, an admin email change calls `clearEmailConfirmation`, anonymising clears `google_sub` / `google_email` and `has_password`. `SafeUser` / `UserProfile` drop `googleSub` / `googleEmail`. |
| `src/server/services/invites.ts` | + `findLiveInvite(db, token, now)`, `completeInviteAcceptance(tx, { user, tokenId, now, via: "link" \| "google", passwordHash: string \| null, name?, emailConfirmed, ip?, userAgent?, requestId? })` (the ONE accept core: marks the token used or consumes every live invite token, sets `accepted_at` / `last_login_at` / name / password (+ `has_password` when a hash is given), bumps `session_version`, marks the email confirmed when `emailConfirmed`, audits `user.accepted_invite` with `metadata.via`). `deliverInvite` now goes through `sendAccountEmail` with `senderUserId = inviter` and returns `notSentReason`. |
| `src/server/services/organisations.ts` | `OwnerDef` + `hasPassword?`, `emailVerifiedAt?`, `googleSub?`, `googleEmail?`; `createOrganisationWithOwner({ isDemo? })`; exported `emailTaken(db, email)`. |
| `src/server/queries/accountSecurity.ts` | `getAccountSecurity(db, ctx, env?)` → `AccountSecurityOverview`; `accountBannerState(viewer, env?)` → `AccountBannerState`; `accountPathFor(role)`, `accountSurfaceFor(role)`. |
| `src/components/auth/caps-lock.tsx` | `useCapsLock()` → `{ capsLock, onKeyEvent, reset }` (wire `onKeyDown` + `onKeyUp` to `onKeyEvent`, `onBlur` to `reset`), `CapsLockHint({ show, id? })` ("Caps Lock is on"). |
| `src/components/account/account-banners.tsx` | `AccountBanners({ state })` — rendered by the staff shell (`AppShell banner` prop) and the portal layout; renders `DemoStudioBanner` and/or `UnconfirmedEmailBanner`. |
| `src/components/account/account-security-section.tsx` | `AccountSecuritySection({ overview })` — on Settings → My account AND `/portal/account`. Demo studio: one read-only notice. Otherwise, in order: `EmailAddressCard`, `PasswordMethodCard`, `GoogleSignInCard`, `SignOutOthersCard`. |

## 4. Lanes — who owns what

Every slot component below already exists as a STUB with its final props, wired into its page. Its owner
replaces the body (keep the export name and props; adding optional props is fine). Stubs render nothing or
the current behaviour.

### AREA verify — email confirmation

Owns (create / edit):
- `src/server/services/emailVerification.ts` (stub exists with the final `sendEmailConfirmation` signature and `EmailConfirmationSendResult`) + `emailVerification.test.ts`
  - `sendEmailConfirmation(db, { userId, reason: "signup" | "resend", req?, requestId? })` → `EmailConfirmationSendResult { sent, reason, devLink?, expiresAt? }`. Already called by `POST /api/auth/signup` (`reason: "signup"`). When `accountEmailBlock` says `not_configured` / `demo` → issue NOTHING and return that reason (the feature is invisible without email). Else, in one tx: `issueToken(kind "email_verify", targetEmail = user.email)` + audit `user.email_confirmation_sent` (metadata `{ targetUserId, reason, superseded }`); after commit `sendAccountEmail` (`confirmEmailEmail`, link `verifyEmailUrl`). Already confirmed → `{ sent: false, reason: "already_confirmed" }`.
  - `resendEmailConfirmation(db, ctx, { req?, requestId? })` — signed in, any role. `enforceRateLimit(db, "verifyResend", userKey(ctx.userId))`. Demo → `reason: "demo"`. Already confirmed → 422 `RuleViolationError("Your email is already confirmed")`. Else `sendEmailConfirmation(reason "resend")`.
  - `confirmEmail(db, raw)` — public, `VerifyEmailInput`. Live `email_verify` token whose `target_email` equals the user's CURRENT email, user active + not anonymised → `markTokenUsed` + `markEmailConfirmed(via "link")` (context: `buildContextFromDb`, else `systemContext(org, { cause: "user" })`) → `{ email, userId }`. Anything else → 400 `ValidationError("This confirmation link is no longer valid")` (formErrors only). Never signs anyone in.
- Routes: `src/app/api/auth/verify-email/route.ts` (POST `{ token }` → `{ ok: true, email, signedIn, redirectTo }`; `redirectTo` = `homePathFor` when the request carries a session, else `/login?email=<email>`), `src/app/api/auth/email-verification/resend/route.ts` (POST, `requireAnyContext`) → `EmailConfirmationSendResult`. Both: JSON 405 for other methods.
- Page `src/app/(auth)/verify-email/{page,loading,error}.tsx` (public — already in `PUBLIC_PREFIXES` and robots' disallow) + island `src/components/auth/verify-email-form.tsx`: "Confirm your email" + [Confirm my email] → success "Email confirmed" + [Continue]; dead link → `InvalidLinkCard` ("If you already confirmed it, you're all set."). Recommended: `metadata.referrer = "no-referrer"`.
- `src/components/account/unconfirmed-email-banner.tsx` (stub) — "Please confirm your email. We sent a link to x. [Send again] [Change email]" (Send again → resend route, toast; 429 → "Try again in N minutes"; Change email → `accountHref`). Quiet (not an alarm colour). Only rendered when `AccountBanners` decides (email configured, not demo, unconfirmed).
- `src/components/account/email-confirmation-status.tsx` (stub, rendered INSIDE `EmailAddressCard`) — "Confirmed" chip, or "Not confirmed yet · [Send again]" (only when `overview.emailConfigured && !overview.isDemo`).
- Unconfirmed-sender copy for invites: `src/components/settings/invite-link-panel.tsx` (+ pass `notSentReason` from `src/components/settings/invite-person-dialog.tsx`, `src/components/production/client-invite-dialog.tsx`, `src/components/production/client-online-access.tsx`): when `notSentReason === "unconfirmed_sender"` say "Nothing was emailed: confirm your own email first, then new invites go out by email. Send this link yourself for now." The gating itself is ALREADY in `deliverInvite`.
- New e2e spec `e2e/accounts-verify.spec.ts` (optional).

### AREA account — Settings → My account

Owns:
- `src/server/services/account.ts` (new) + `account.test.ts`
  - `requestEmailChange(db, ctx, raw, { req?, requestId? })` — `ChangeEmailInput`; `assertNotDemo(ctx, "email")`; `!hasPassword` → 422 "Set a password first, then you can change your email"; `enforceRateLimit("emailChange", userKey)`; wrong password → `limiters.passwordCheck.hit` + 400 `fieldErrors.password`; same as current → 400 `fieldErrors.newEmail`; taken by anyone → 400 `fieldErrors.newEmail` "That email is already in use". Email configured (`accountEmailBlock` null): tx { `issueToken(kind "email_change", targetEmail = newEmail)` + audit `user.email_change_requested` } → `sendAccountEmail({ to: newEmail, content: confirmNewEmailEmail, link: confirmEmailChangeUrl })` + `sendEmailChangedNotice(stage "requested")` → `{ status: "pending", newEmail, expiresAt, sent, devLink? }`. Not configured: tx { update email, `clearEmailConfirmation`, version+1, audit `user.email_changed` (`metadata.via: "direct"`) } → `{ status: "changed", email }`.
  - `cancelEmailChange(db, ctx)` → consumes live `email_change` tokens, audits `user.email_change_cancelled` when any → `{ cancelled }`.
  - `confirmEmailChange(db, raw)` — public, `ConfirmEmailChangeInput`: live token, user active; `target_email` taken by ANOTHER user now → 400 "That email is now used by another account"; else update email + `email_verified_at = now` (the link proved it) + version+1, consume the token, audit `user.email_changed` (`via: "link"`) and `user.email_confirmed` (via `markEmailConfirmed(..., via "email_change")` after `clearEmailConfirmation`, or set directly and record the event — keep both events), after commit `sendEmailChangedNotice(stage "changed")` → `{ email, userId }`. Unique-index race → the same 400.
  - `setPassword(db, ctx, raw)` — `SetPasswordInput`; `assertNotDemo(ctx, "password")`; `hasPassword` → 422 "You already have a password. Use Change password."; hash, `has_password = true`, version+1 (session_version unchanged), audit `user.password_changed` with `metadata { self: true, via: "set" }`; after commit `sendPasswordChangedNotice(via "set")`.
  - `signOutOtherDevices(db, ctx, meta)` — `assertNotDemo(ctx, "sessions")`; bump `session_version`, audit `auth.other_sessions_revoked`, then `issueSessionCookie` with the new version → `{ ok: true }`.
- Routes (all `requireAnyContext` except confirm; JSON 405 otherwise): `src/app/api/auth/email-change/route.ts` (POST), `src/app/api/auth/email-change/cancel/route.ts` (POST), `src/app/api/auth/email-change/confirm/route.ts` (POST, public → `{ ok: true, email, signedIn, redirectTo }`), `src/app/api/auth/set-password/route.ts` (POST), `src/app/api/auth/sign-out-others/route.ts` (POST).
- Page `src/app/(auth)/change-email/{page,loading,error}.tsx` (public; in `PUBLIC_PREFIXES`) + island `src/components/auth/confirm-email-change-form.tsx` — confirm on button press, like verify.
- Slots: `src/components/account/email-address-card.tsx` (`id="email"` anchor; shows the email, KEEPS rendering `<EmailConfirmationStatus overview={overview} />`, pending change "Waiting for you to open the link we sent to y · [Cancel]", the change form; Google-only accounts see "Set a password first"), `src/components/account/password-method-card.tsx` (stub renders today's `ChangePasswordForm`; becomes: has password → change form + "Changing it signs you out everywhere else"; no password → "Set a password"), `src/components/account/sign-out-others-card.tsx`.
- `src/components/settings/profile-forms.tsx` (the "Your email … set by the studio owner" line now points at the Email card; reuse / move `ChangePasswordForm`), `src/components/portal/portal-account-forms.tsx` (the read-only email field points at the Email card).
- New e2e spec `e2e/accounts-account.spec.ts` (optional).

### AREA google — "Continue with Google"

Owns:
- `src/server/auth/google-oidc.ts` (new): PKCE (`S256`), state, nonce, authorize URL (`scope=openid email profile`, `prompt=select_account`, `redirect_uri = googleRedirectUri(req)`), code exchange (POST `GOOGLE_OIDC.tokenUrl`, `client_secret`, `code_verifier`), id_token verification with jose `jwtVerify` + `createRemoteJWKSet(GOOGLE_OIDC.jwksUrl)` (iss ∈ `GOOGLE_OIDC.issuers`, aud = client id, `nonce`, exp), requires `email_verified === true`. Test seams: injectable `fetch`, JWKS (`JWTVerifyGetKey`), clock.
- `src/server/services/googleAuth.ts` (new) + tests covering EVERY outcome without Google:
  - `beginGoogleSignIn(req, raw: GoogleStartInput, deps?)` → `{ location, cookie }`: 404 `NotFoundError` when `googleAuthConfig()` is null; `next` through `safeNextPath`; state cookie = `signPurposeToken({ state, nonce, verifier, intent, invite?, next?, uid? }, "google_oauth", GOOGLE_OAUTH_TTL_MINUTES*60)` (`uid` = the signed-in user for `intent=connect`, which requires a session).
  - `handleGoogleCallback(db, req, deps?)` → `{ location }` (+ session cookie via `startSession` / `issueSessionCookie`). `enforceRateLimit("googleCallback", ipKey(clientIp))`. Missing/expired/mismatched state → `?google=expired`; `error=access_denied` → `?google=cancelled`; token / JWKS failure → `?google=failed`; `email_verified` false → `?google=unverified_email`. Resolution order: (1) `intent=connect` → link to the session user (`assertNotDemo(ctx, "sign_in_methods")`; sub used by another user → `linked_elsewhere`), audit `user.google_connected` → `<accountPath>?google=connected`. (2) `intent=invite` + live invite (`findLiveInvite`) → sub linked elsewhere → `linked_elsewhere`; else `completeInviteAcceptance({ via: "google", passwordHash: null, emailConfirmed: googleEmail === user.email })` + set `google_sub` / `google_email` (same tx) → sign in. Dead invite → `/invite/<token>`. (3) known `google_sub` → `startSession(method "google")` (refusals → `/login?google=refused`). (4) same email (lower-cased): accepted + active (not demo) → link + `markEmailConfirmed(via "google")` + audit `user.google_connected` + sign in; pending invitee → `completeInviteAcceptance({ via: "google", emailConfirmed: true })` + link + sign in; inactive / anonymised / portal off / demo → `?google=refused` (same generic copy as a failed password sign-in — never say why). (5) no account → `GOOGLE_SIGNUP_COOKIE` = `signPurposeToken({ sub, email, name }, "google_signup", 15 min)` → `/signup/google` (`?from=signin` when intent was signin). Sign-in landing = `loginRedirectTarget(role, next)`.
  - `completeGoogleSignUp(db, raw: GoogleCompleteInput, deps?)` — finish cookie required (else 400 "Start again with Continue with Google"); honeypot filled → generic 400; `enforceRateLimit("signup", signupKey(ip, email))`; email taken (race) → 400 `EMAIL_IN_USE_MESSAGE`; one tx: `createOrganisationWithOwner({ owner: { passwordHash: unusablePasswordHash(), hasPassword: false, emailVerifiedAt: now, googleSub, googleEmail }, cause: "signup" })` + `bootstrapOrganisation` + `recordSignIn(method "google")`; then `issueSessionCookie` + `markSignedUp()`; clears the finish cookie → `{ redirectTo: "/home", organisationId, slug, user }`.
  - `disconnectGoogle(db, ctx)` — `assertNotDemo(ctx, "sign_in_methods")`; `!hasPassword` → 422 "Set a password before you disconnect Google"; nulls both columns, audits `user.google_disconnected`.
  - Audit: `auth.logged_in` (`method: "google"`), `auth.login_failed` (`metadata.method: "google"`, only when an account matched), `user.accepted_invite` (`via: "google"`), `user.google_connected` / `user.google_disconnected`, `user.email_confirmed` (`via: "google"`), `org.created` / `user.created` (cause `signup`).
- Routes: `src/app/api/auth/google/start/route.ts` (GET → 302), `src/app/api/auth/google/callback/route.ts` (GET → 302), `src/app/api/auth/google/complete/route.ts` (POST), `src/app/api/auth/google/disconnect/route.ts` (POST, `requireAnyContext`). JSON 405 for other methods.
- Page `src/app/(auth)/signup/google/{page,loading,error}.tsx` (public; in `PUBLIC_PREFIXES`) + island `src/components/auth/google-signup-form.tsx`: asks only "Studio name" (owner name prefilled from Google, editable); `from=signin` explains "No Proofline account for x yet — create a studio, or if you edit for a studio, ask them for an invite". No / expired cookie → "Start again" card.
- Slots: `src/components/auth/continue-with-google.tsx` (`ContinueWithGoogle({ intent: "signin" | "signup" | "invite", next?, invite?, result?, className? })` — already placed on /login (with `next` and `?google=`), /signup (`?google=`) and /invite/[token] (the cleaned token and `?google=`); renders NOTHING unless `googleAuthConfig()`; also renders the `?google=<result>` message for that page; may become an async server component), `src/components/account/google-sign-in-card.tsx` (connect / disconnect; disconnect only when `overview.hasPassword`; nothing when Google is not configured and not connected).
- `src/app/(auth)/invite/[token]/page.tsx` and `src/components/auth/accept-invite-form.tsx` (only if the Google button needs layout changes there).
- Unit tests must not hit the network.

### AREA access — sessions, limits, abuse, demo, signed-in visitors, polish

Owns:
- `src/proxy.ts` + `src/proxy.test.ts`: (a) sliding sessions — when the cookie verifies and `renewSessionToken(token)` returns a token, set it on the response with `sessionCookieOptions()` (every response kind: next / redirect / API); never for an invalid cookie; (b) `/` is public for everyone (no redirect, no portal bounce); (c) `/login` and `/signup` are NOT redirected for signed-in people any more (the pages show a notice); `?expired=1` still deletes the cookie.
- Rate limits: swap every caller to `src/server/auth/db-rate-limit.ts` (`services/auth.ts`, `services/organisations.ts`, `services/passwordReset.ts`), delete `src/server/auth/rate-limit.ts` + `rate-limit.test.ts`, update the existing tests that import them (`auth.test.ts`, `invites.test.ts`, `passwordReset.test.ts`, `signup.test.ts`, `signup.session.test.ts`, plus any other). Wire `passwordCheck` into `preparePasswordChange` (wrong current password).
- Sign-up abuse (`services/organisations.ts`): honeypot `website` non-empty → generic 400 `ValidationError("We couldn't create your studio. Please try again.")`; an email of a PENDING invitee (active, `accepted_at` null, not anonymised) → 400 `fieldErrors.email = ["This email has been invited to a studio. Use the invite link in your email, or ask the studio to send it again."]` (never the studio's name); other taken emails unchanged.
- Demo hardening (services you own): `assertNotDemo` in `services/users.ts` (`inviteUser` / `inviteUserByMethod` → "invite"; admin `resetPassword` → "reset_password"; `updateUser` with `email` → "email"; `deactivateUser`, `changeRole`, `setAdmin`, `anonymiseUser`, `setPermissions` on a `DEMO_ACCOUNTS` persona user → "demo_accounts"), `services/invites.ts` (`createInvite` / `resendInvite` / `revokeInvite` → "invite"), `services/auth.ts` (`changePassword` → "password"; `recordLogout` must NOT bump `session_version` in a demo studio — just clear the cookie, or every visitor sharing that persona is signed out), `services/passwordReset.ts` (`requestPasswordReset` for a demo user → no token, `{ ok: true, emailed: false }`; `resetPassword` for a demo user → the generic invalid-link 400). Email is already suppressed for demo studios by `sendAccountEmail`.
- Demo sign-in: `src/server/services/demo.ts` (new) + test: `demoSignIn(db, raw: DemoSignInInput, meta)` → `!demoSignInEnabled()` or no persona user → 404 `NotFoundError("Demo", "The demo studio is turned off")`; `enforceRateLimit("demoSignIn", ipKey(ip))`; `startSession(method "demo")` → `{ redirectTo: loginRedirectTarget(role, null) }`. Route `src/app/api/auth/demo/route.ts` (POST, public).
- `src/components/account/demo-studio-banner.tsx` (stub): "You're looking at the demo studio. Anyone can see changes here. [Create your own studio]" — the button signs the visitor out and lands on /signup (form → a sign-out server action with an allowlisted return path).
- Login page: `src/app/(auth)/login/{page,login-form}.tsx` (+ new `src/components/auth/demo-panel.tsx`): NO demo emails / passwords any more; "Look around the demo" panel, one button per persona (Owner, Photographer, Editor, Client) → POST /api/auth/demo → `router.push(redirectTo)`; shown only when `demoSignInAvailable(db)`; `/login?demo=1` puts the panel first (keep the existing hide rules for `?from=invite` and a signed-up browser). KEEP `<ContinueWithGoogle … />` where it is. Caps-lock hint on the password field; locked-out message keeps "Try again in N minutes" (from the DB limiter).
- Signed-in visitors: `src/app/(public)/layout.tsx` (no redirect), `src/components/marketing/public-header.tsx` (signed in → one "Go to your studio" button → `homePathFor`), `/login` and `/signup` render "You're signed in as <name>. [Go to your studio] [Sign out]" instead of the form (as built: [Log out], role-worded home button — §8 Review fixes) (generalise `src/components/auth/signed-in-notice.tsx` — keep its current props working for the invite page — and `src/server/actions/auth.ts` for a sign-out action with an allowlisted return: `/login`, `/signup`, `/invite/*`).
- Sign-up page polish: `src/app/(auth)/signup/page.tsx` (KEEP `<ContinueWithGoogle … />`), `src/components/auth/signup-form.tsx` (hidden honeypot input `name="website"` — off-screen, `tabIndex={-1}`, `autoComplete="off"`, `aria-hidden`; caps-lock hint; the line "Editing for a studio, or a client? Use the invite link your studio sent you."; the pending-invitee field error shows as-is).
- `src/components/auth/password-field.tsx` (caps-lock hint via `useCapsLock`), `src/server/actions/auth.ts`, `src/app/api/auth/{login,signup,logout,forgot-password,reset-password}/route.ts` (keep the `sendEmailConfirmation` call in signup), `src/app/(app)/settings/people/**` + `src/components/settings/people-toolbar.tsx` (demo: the Invite button explains "Invites are turned off in the demo studio").
- Existing e2e specs that look at the old demo box: `e2e/landing.spec.ts`, `e2e/signup.spec.ts`, `e2e/invite-flow.spec.ts` (+ optional new `e2e/accounts-access.spec.ts`). E2E logs in through the API with the seeded passwords — they keep working. NOTE: the e2e database is seeded with `SEED_DEMO=off` (foundation, `e2e/prepare-db.mjs`), so there the demo panel does NOT show (`demoSignInAvailable` is false); a spec that exercises the panel must skip unless the studio is a demo (e.g. look for `[data-demo-panel]` and `test.skip`), or run after `SEED_DEMO=on npm run e2e:prepare`.

### Shared — foundation-owned (NOBODY else edits)

`src/db/schema.ts`, `drizzle/**`, `src/db/guard.ts`, `src/db/test-db.ts`, `src/db/test-db.test.ts`, `src/db/seed/**`,
`src/lib/constants.ts`, `src/lib/types.ts`, `src/lib/validation/auth.ts`, `src/lib/audit-summaries.ts`,
`src/components/activity/event-groups.ts`, `src/server/auth/{session,session-token,sign-in,demo,email-confirmation,db-rate-limit,google-config,tokens,redirect,permissions}.ts`,
`src/server/origin.ts`, `src/server/email/{index,templates,account}.ts` (+ their tests),
`src/server/services/accountNotices.ts`, `src/server/services/_shared.ts`, `e2e/prepare-db.mjs`,
`src/server/queries/accountSecurity.ts`, `src/components/account/{account-banners,account-security-section}.tsx`,
`src/components/auth/caps-lock.tsx`, `src/components/shell/**`, `src/app/(app)/layout.tsx`, `src/app/portal/layout.tsx`,
`src/app/(app)/settings/account/page.tsx`, `src/app/portal/account/page.tsx`, `src/app/robots.ts`,
`src/components/ui/**`, `.env.example`, `CLAUDE.md`, `docs/**`, `src/app/api/README.md`.

Existing service files have ONE owner after the foundation: `auth.ts`, `organisations.ts`, `passwordReset.ts`,
`invites.ts`, `users.ts` → AREA access. The other areas only CALL their exported functions
(`completeInviteAcceptance`, `findLiveInvite`, `createOrganisationWithOwner`, `bootstrapOrganisation`,
`emailTaken`, `EMAIL_IN_USE_MESSAGE`, …). Existing test files: only AREA access edits them; the other areas
add NEW test files.

## 5. Audit events (all management visibility; summaries + History groups already written)

| Event | Action | Written by | Metadata (keys) |
|---|---|---|---|
| `user.email_confirmation_sent` | `requested` | verify | `targetUserId`, `reason` ("signup" \| "resend"), `superseded`, `sent` |
| `user.email_confirmed` | `confirmed` | `markEmailConfirmed` | `targetUserId`, `via` (`EMAIL_CONFIRMATION_VIA`) |
| `user.email_change_requested` | `requested` | account | `targetUserId`; newValue `{ pendingEmail, expiresAt }` |
| `user.email_change_cancelled` | `revoked` | account | `targetUserId`, `cancelled`; newValue `{ pendingEmail }` |
| `user.email_changed` | `updated` | account | `targetUserId`, `via` ("link" \| "direct"); prev/new `{ email }` |
| `auth.other_sessions_revoked` | `revoked` | account | prev/new `{ sessionVersion }` |
| `user.google_connected` | `connected` | google | `targetUserId`, `via` ("connect" \| "sign_in" \| "invite" \| "signup"); newValue `{ googleEmail }` |
| `user.google_disconnected` | `disconnected` | google | `targetUserId`; prev `{ googleEmail }` |
| `auth.logged_in` | `logged_in` | `recordSignIn` | `method` (`SIGN_IN_METHODS`), `ip`, `userAgent` |
| `user.password_changed` | `updated` | existing + account | `self`, `via` ("set" for set-password), `reset` |
| `user.accepted_invite` | `accepted` | `completeInviteAcceptance` | `via` ("link" \| "google") |

## 6. UI composition (already wired)

- Staff shell: `src/app/(app)/layout.tsx` → `AppShell banner={<AccountBanners state={accountBannerState(viewer)} />}` (above the page content). Portal: `src/app/portal/layout.tsx` renders the same above `<main>`.
- `AccountBanners`: demo → `DemoStudioBanner` (access); otherwise unconfirmed + email configured → `UnconfirmedEmailBanner` (verify).
- Settings → My account (`/settings/account`) and `/portal/account`: `ProfileForm` / name form, then `AccountSecuritySection` (`EmailAddressCard` [account] ⊃ `EmailConfirmationStatus` [verify]; `PasswordMethodCard` [account]; `GoogleSignInCard` [google]; `SignOutOthersCard` [account]; each renders its OWN `SectionCard` — no nesting), then notifications / appearance. In a demo studio the section is one read-only notice instead (no card ever has to handle the demo).
- /login: `AuthPageHeader` + `LoginForm` [access] + `ContinueWithGoogle intent="signin" next result` [google]. /signup: `SignUpForm` [access] + `ContinueWithGoogle intent="signup" result` [google]. /invite/[token]: `AcceptInviteForm` + `ContinueWithGoogle intent="invite" invite={token} result` [google].

## 7. Verification each area runs before reporting

`npx tsc --noEmit`, `npx eslint <your files>`, `npx vitest run <your test files>` (the full suite is ~5 min;
the coordinator runs it once at the end). Report real results and every contract deviation.

## 8. As built — deviations from §1–§7

Every item below is deliberate and covered by tests; `docs/ACCOUNTS.md` and `src/app/api/README.md` describe the
result.

**Email confirmation (verify)**
- Without a mail provider, OUTSIDE production a link IS issued and handed back as the dev-only `devLink` (from
  `POST /api/auth/email-verification/resend` and in `emailConfirmation` of the `POST /api/auth/signup` response), so
  dev and e2e can walk the flow. Production without a provider still issues nothing (plan: issue nothing anywhere).
- The 400 of `POST /api/auth/verify-email` carries `details.reason` = `invalid` | `expired` | `used` |
  `already_confirmed` (message unchanged), so the page can show the right next step (replaced link, expired, broken,
  already confirmed, too many tries).
- The unconfirmed-sender invite copy is "Your invite wasn't emailed because your own email isn't confirmed yet. Copy
  the link below and send it yourself, or confirm your email first." shown ABOVE the link (also on the person page's
  "Send a new link", `InviteStatusCard`).

**My account (account)**
- Extra route + service: `POST /api/auth/email-change/resend` (`resendEmailChange`) — "Send again" for a waiting
  change, no password, shares the 5-an-hour `emailChange` limit.
- `POST /api/auth/email-change` "pending" also returns `reason`. Confirm 400s carry `details.reason` = `invalid_link`
  | `email_taken`; a taken address (at confirm or resend) closes the waiting change first (`user.email_change_cancelled`
  with `reason: "taken"`). Confirm `redirectTo` = `<account page>#email` when signed in as the same person, their
  home when signed in as someone else, `/login?email=<new>` when signed out.
- Audit metadata: `user.email_change_requested` also has `superseded`, `ip`, `userAgent` (+ `resend: true`);
  set-password writes `user.password_changed` with previous `{ hasPassword: false }` / new `{ hasPassword: true }`.
- New card anchor `#devices` (Sign out of other devices — as built "Log out of other devices", §8). 429s say "Too many wrong passwords. / Too many email changes
  asked for. Try again in N minutes."

**Continue with Google (google)**
- Google not configured: start / callback answer a 302 back to the page with `?google=disabled` (never a 404 / JSON
  / error page); `complete` works whenever the signed finish cookie is valid; `disconnect` always works.
- Linking an existing account by matching email happens only when Google is the authority for the address (Gmail, or
  a Workspace account whose `hd` is the address's domain) AND the account has NO password (review fix SEC-01, below);
  otherwise the person signs in with their password and uses Connect Google. Connect also confirms the email when
  the Google address is the same and Google is authoritative.
- A pending invitee joins through "same email" only with a LIVE invite (re-read and consumed inside the transaction).
- `complete` keeps a sign-in's safe `next` (`redirectTo` = `/home` or that path); its honeypot answer, limit copy and
  pending-invitee message are the email sign-up's (`honeypotFilled`, `SIGNUP_REFUSED_MESSAGE`, `enforceLimit(…,
  "signup")`, `emailUse` — unified by the integrator).
- `AcceptInviteForm` gained an optional `alternative` slot (the Google option between the password card and "Already
  joined?").

**Access**
- The honeypot answer is "Something went wrong. Please try again." (`SIGNUP_REFUSED_MESSAGE`), not the plan's "We
  couldn't create your studio…"; it is checked on the raw body before validation and still counts toward the limit.
- New limiter `RATE_LIMITS.resetLink` (10 / 15 min per KNOWN client IP) for reset-password submits with a dead link,
  checked before the new password is hashed (`resetLinkLimiter` in `src/server/services/authLimits.ts`).
- Every front-door / account 429 has plain copy per topic (`rateLimitMessage` / `plainRateLimited` /
  `enforceLimit` in `authLimits.ts`); `retry-after` and `details.retryAfterSeconds` unchanged.
- Sliding-session renewal happens on GET / HEAD only (never on POST / PATCH / PUT / DELETE, `/api/auth/*`, `_next`,
  `?expired`) so a renewed cookie can never overwrite a handler's own sign-in / sign-out cookie.
- Demo studio: `transferPrimaryOwner` is refused too; `recordLogout` records `auth.logged_out` with
  `{ allSessionsRevoked: false, demo: true }`. Clients page: invite / resend / revoke / reset controls hidden in the
  demo (integrator); the person page says "Invites are turned off in the demo studio." on a pending invite.
- `e2e/auth.spec.ts` and `e2e/redirects.spec.ts` (old demo box / signed-in redirect) were updated too.

**Integrator**
- A signed-in visitor on `/` gets "Go to your studio" in the hero and the closing call to action as well (not only
  the header).
- `InvalidLinkCard` takes an optional `title` and an optional `footer` (a SECOND way forward); the old `showSignIn`
  "Already have a password? Sign in" line is gone (review fix UX-14).
- The demo banner lines up with the portal's narrower column (`surface`).
- `src/server/auth/google-config.ts` JSDoc corrected (no 404s).
- `POST /api/auth/signup` returns `emailConfirmation` (verify's request); `e2e/api.ts` `SignUpResponse` has it.
- Login page lede: "Welcome back. Sign in with your email and password." (invitees choose their own password now);
  My account's profile line no longer tells an owner that the studio owner decides what they can do.
- Settings → People: "Done" after an invite closes the dialog at once (it used to show the emptied form until the
  `?invite` URL change landed).
- `e2e/fixtures.ts` hides the `next dev` tools badge (`hideDevOverlay`; `E2E_SHOW_DEV_OVERLAY=1` keeps it): a
  Next.js "security insight" pill covered the sidebar's Collapse button and failed `stacking.spec.ts`.

### Review fixes (four reviews: security, walkthrough, data, demo/production — 2026-10-24)

Every finding id below is from those reviews; each has a regression test (vitest and/or Playwright —
`src/server/services/accountsHardening.test.ts`, `e2e/accounts-review-fixes.spec.ts` and the suites named).

**Security**
- SEC-01 / DATA-03 — Continue with Google never links "same email" into an account that has a password (anyone can
  create an account in someone else's Gmail address and wait). The verified owner of the address gets
  `?google=use_password` ("There's already a Proofline account with that email. Sign in with your password below…,
  then turn on Google in My account") and `auth.login_failed` (reason `has_password`) is recorded. Pending invitees
  (live invite) and password-less accounts still join / link as before. The 0007 confirmation backfill therefore no
  longer matters to Google. (`googleAuth.ts` `linkByEmail`; `googleAuth.test.ts`.)
- SEC-02 — `safeNextPath` parses `next` like a browser (WHATWG URL against a fake origin), refuses control characters
  and backslashes anywhere, and returns the normalised path — refusing it when dot segments normalise it into a
  protocol-relative `//host` (`/.//evil`, `/a/..//evil`, `/%2e//evil`; found by the final verification).
  (`redirect.ts`; `redirect.test.ts`, Google + e2e.)
- SEC-03 — Connect Google needs the current password: `POST /api/auth/google/connect { password }`
  (`beginGoogleConnect`, the shared `passwordCheck` limiter) returns Google's URL; `GET /api/auth/google/start?intent=connect`
  never starts a round trip (it lands on the account page's Google card). A successful connect emails "Google sign-in
  was added to your Proofline account" to the account's address (`sendGoogleConnectedNotice`). The Google card asks
  for the password inline. "Set a password" (a Google-only account: no password to ask for) needs a RECENT sign-in
  instead: the session cookie carries `at` (when this browser really signed in — kept by renewals and by "Log out of
  other devices", absent on older cookies), the context `ctx.signedInAt`, and `setPassword` refuses after 15 minutes
  with 403 `account.recent_sign_in` (the card then offers Continue with Google to sign in again). Not done: making
  "Log out of other devices" / a reset also disconnect Google — the notice plus the card's Disconnect cover it.
- SEC-04 — Sign-up's "is this address taken / invited?" lookup on a form with mistakes now runs only after the sign-up
  limiter has counted the attempt (`parseSignUp(…, beforeLookup)`): 5 per hour per network (per address when the
  network is unknown). The pending-invitee wording stays (only after the limiter).
- SEC-05 — Opening an invite link confirms the address only when the inviter's own email is confirmed AND email is set
  up (`inviteVouchesForAddress`); otherwise the invitee is sent "Confirm your email" right after joining
  (`sendEmailConfirmation` reason `invite`). 0008 (e) un-confirms people who have not joined yet (0007 had
  backfilled them). Google invite acceptance confirms only when Google is the authority for exactly that address.
- SEC-06 — Known devices (`src/server/auth/known-device.ts`, cookie `pl_known_device`, 180 days, a keyed hash of the
  address + a random id): every real sign-in remembers the browser; such a browser's failures count under its own
  `loginDevice` key and the per-email backstop never applies to it, so strangers can't lock the owner out of a
  browser they already use. Unknown browsers keep the email+IP and per-email limits.
- SEC-07 / DEMO-01 — In a demo studio the Client persona's client can't have its portal switched off or be archived
  (`assertNotDemoPersonaClient`, 403 `demo.demo_accounts`); the switch is locked with plain copy, Archive is hidden,
  and the demo panel handles a 401 itself ("The demo isn't open as Client right now") instead of the global
  "your session ended" redirect (`api` option `redirectOn401: false`).
- SEC-08 — Changing an email (self or admin) also uses up live reset links (`clearEmailConfirmation`), and an admin
  editing a pending invitee's email closes their invite link (`metadata.invitesClosed`; "Send a new link" follows).
- SEC-09 — `verifyPassword` burns a full bcrypt for an unusable hash (no timing oracle for Google-only accounts /
  pending invitees); new `loginIp` limiter (100 failures / 15 min per known IP).
- SEC-10 / DATA-06 / DEMO-05 — Demo sign-in and Google callback limits are skipped when the client IP is unknown
  (`knownIpKey`), instead of one site-wide bucket; production on Vercel without `TRUSTED_PROXY_COUNT` logs a warning
  once (`trustedProxyCount`).

**Data**
- DATA-01 — `scripts/vercel-migrate.mjs` migrates only when `VERCEL_ENV` is `production` (or `MIGRATE_ON_BUILD=1`);
  0006 / 0007 are frozen and every later change is a new migration (0008).
- DATA-02 — `anonymiseUser` uses up every live link of the person and scrubs `target_email` (0008: CHECK + guard allow a
  one-way NULL on a used row); `metadata.linksClosed`. History sentences stay as written (frozen summaries are the
  audit log's design — ARCHITECTURE.md §5).
- DATA-04 — `hasUsablePassword` (flag AND bcrypt hash) everywhere a decision is made; invite acceptance without a
  password writes `has_password` from the hash; 0008 (d) re-syncs the flag.
- DATA-05 — 0008 (c) uses up a demo studio's live invite links; `completeInviteAcceptance` refuses a demo studio.
- DATA-07 — `auth_rate_limits.key_hash` is an HMAC with the session secret (`keyedHash` in `session-token.ts`).

**Demo / production**
- DEMO-02 — `DEMO_SIGN_IN=off` closes the demo studio: password sign-in to an `is_demo` studio gives the generic 401
  (`auth.login_failed` reason `demo_closed`), Google sign-in too (`startSession` refuses a demo account for any method
  but the demo buttons, and those only while demo sign-in is on).
- DEMO-03 — the demo Client persona's row on a client's Online access offers no "Remove access" ("Demo account").
- DEMO-06 — `src/proxy.ts` sets `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` on every response it sees
  (static assets don't pass the proxy). Not done: `poweredByHeader: false` — changing `next.config.ts` restarts the
  shared dev server; it is a one-line follow-up.
- DEMO-07 — the demo's My account Profile hint no longer points at email / password cards that aren't there; a demo
  persona's person page shows the locked reason instead of an empty Account card.
- DEMO-08 — a path with broken percent-encoding never reaches a route: `/invite/…` → `/invite/link-not-valid` (the
  dead-link card), the API → a plain 400 (proxy).
- DEMO-09 — `e2e/accounts-access.spec.ts` creates its own ordinary studio where it invites people, and skips the
  "outside the demo" check when the seeded owner is in the demo studio.

**Walkthrough (plain words, one verb: "Log out")**
- UX-01 — a successful reset forgets the wrong passwords typed for the address (`clearLoginLockout`) and remembers the
  browser, so the new password works at once.
- UX-02 — the wrong-password strip leads with "Forgot your password? Reset it"; the lockout strip adds "Or reset your
  password now — you can sign in with the new one straight away."; the invite / portal hint is one short line.
- UX-03 — "Log out" still ends the account's sign-in on every device (a stateless cookie has no per-device revoke; a
  per-device log out would weaken the logout), and now SAYS so: the signed-in notice, "Log out to accept this
  invite" and the Other devices card ("“Log out” in the menu logs you out everywhere, this device included.").
- UX-04 — every sign-out wording is "Log out": the notice, "Log out of other devices" (card button = dialog title =
  confirm button), password / reset copy, toasts, the password-changed email, the demo copy, History ("logged out",
  "logged out of every other device"), the client / people cards, the Help page and the client portal switch
  (`auth-copy.test.ts` sweeps every screen, email and History source for a leftover "sign(s/ed) … out").
- UX-05 — `/login?expired=1`: "You’ve been logged out on this device. Sign in again to carry on."
- UX-06 — a used invite link opened by the person who used it: "You’ve already joined <studio>" + their home button;
  signed out the dead-link card leads with "Already joined? Sign in below." (`joinedWithInvite`).
- UX-07 / DEMO-04 — the landing page offers the demo only where it is open (`demoSignInAvailable`); the FAQ link is
  `/login?demo=1`.
- UX-08 — a dead reset link: heading + tab "Reset your password", footer "Remembered it? Sign in".
- UX-09 — sign-up, change email, change / set password put focus on the first field with an error after a failed
  submit (`useFocusFirstInvalid`).
- UX-10 — one wrong-password sentence ("That password isn’t right", Change password too), one repeat label ("Type it
  again", the reset page too), curly apostrophes in the account copy.
- UX-11 / UX-21 — the way home fits the role ("Go to your studio" / "Go to my jobs" / "See your work",
  `homeLabelFor`) on the landing page (header, hero, FAQ, footer, closing call to action) and the signed-in notice;
  the notice is one name heading + one sentence.
- UX-12 — the portal says "My account" (menu and page title); the Profile card no longer repeats the email.
- UX-13 — the front door's side panel speaks to studios, editors and clients alike.
- UX-14 — dead-link pages: one heading (the page's), the card carries the body, one main action, no duplicate
  "Already have a password? Sign in", no "This link didn’t open"; the invite page's tab title follows its state.
- UX-15 — `/signup/google` with nothing pending: with Google off, "Signing up with Google isn’t available" + Create
  your studio; signed in, the signed-in notice.
- UX-16 — a Google round trip's result is shown at the TOP of /login, /signup and the invite page
  (`GoogleResultAlert`).
- UX-17 — "Forgot password?", the password eye buttons and the avatar menu are ≥ 40 px to tap on phones; the active
  Settings tab scrolls into view.
- UX-18 — Forgot password's "Send it again" sends again ("Sent again."); "use a different email" reopens the form.
- UX-19 — after a reset a toast says "Your new password is set"; after Log out the sign-in page says "You’re logged
  out." (`/login?logged_out=1`).
- UX-20 — `/verify-email`: no card question, the button says what it does; a signed-in, already-confirmed person is
  told so before pressing (Continue + a quiet "Confirm this link anyway"); signed out, the confirmed state's button
  is "Sign in".

Local databases that already applied 0007 (the dev and e2e PGlite folders) need `npm run db:migrate` (additive) to
get 0008 — until then anonymising someone who has an email-change / confirm link fails on the old guard.
