# Accounts — sign-up, sign-in and everything around them

How people get into Proofline and look after their own account, **as built** on branch `feat/accounts`. The build
contract (who built which file, the shared helpers, and every deviation from the original plan) is
`docs/ACCOUNTS-PLAN.md`; the API routes are in `src/app/api/README.md` → "Front door" and "Accounts". Plain words
throughout: the people using this are photographers, editors and their clients.

Screenshots (desktop 1440 + phone 390): `docs/screenshots/accounts/`.

## 1. The flows

| Who | How they get in | Then |
|---|---|---|
| A studio owner | **Create your studio** (`/signup`): name, email, password, studio name — or **Continue with Google** and just the studio name (`/signup/google`) | Signed in on Home. A "Confirm your email" link is emailed (when email is set up; Google sign-ups are already confirmed). |
| An editor / photographer / client | The owner invites them (Settings → People, or a client's Online access). They open the **invite link** and choose a password — or press **Continue with Google** on the invite page (when Google is set up) | Signed in. Their email counts as confirmed only when the person who invited them has confirmed their own email and email is set up (the inviter can always copy the link, so opening it proves nothing by itself); otherwise "Confirm your email" is sent straight away. Editors land on My jobs, clients in the portal. |
| Anyone with an account | **Sign in** (`/login`) with email + password, or **Continue with Google** | Owners / photographers land on Home, editors on My jobs, clients in the portal (or the page they were sent from, `?next=`). |
| Forgot the password | **Forgot password?** → a 60-minute reset link by email (`/reset-password`) | Signed in; every other device signed out; "Your password was changed" email. This also works for a Google-only account (it gets its first password). |
| A visitor | **See the demo studio** (landing page) → `/login?demo=1` → "Look around the demo": Owner · Photographer · Editor · Client | Signed into the shared demo studio as that person (no email or password shown anywhere). Only where a demo studio exists and `DEMO_SIGN_IN` is not `off`; otherwise `?demo=1` says plainly that the demo isn't open. |

A signed-in person who opens `/` sees the landing page with one button back home — in words that fit them: **Go to
your studio** (owners / photographers), **Go to my jobs** (editors), **See your work** (clients) — in the header, the
hero, the FAQ, the footer and the closing call to action, instead of "Create your studio" / "Sign in". On `/login`
and `/signup` they see their name, "<email>, on this browser. Logging out also logs you out on your other devices."
and [that button] [Log out] instead of a form (logging out lands back on the same page, ready to use). An invite link
opened while someone else is signed in offers "Log out to accept this invite" (and says the same about other
devices). Reopening your OWN invite link after joining says "You’ve already joined <studio>" with your home button.

The app says **Log out** everywhere (the menus, the notices, "Log out of other devices", toasts, emails, History). "Log
out" ends the account's sign-in on every device — the session is a signed cookie with a version number, so there is
no per-device revoke — and the screens say so; "Log out of other devices" (My account) keeps this one signed in.

### Sign-up details

- The form has a hidden honeypot field (`website`). A bot that fills it gets one generic "Something went wrong.
  Please try again." — no field errors to learn from — and the attempt still counts toward the sign-up limit. The
  Google sign-up answers a bot the same way.
- An address that already has an account → "That email is already in use. Try signing in." An address with an
  invite nobody has opened yet → "This email has been invited to a studio. Use the invite link in your email, or ask
  the studio to send it again." (never the studio's name). Both sign-ups (email and Google) say the same.
- Under the form: "Editing for a studio, or a client? Use the invite link your studio sent you."
- Password fields show "Caps Lock is on" while it is.

### Continue with Google (only when `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` are set)

What a verified Google account means, in this order:

1. **Connect** (My account → Google → Connect Google): asks for the current password first (a new way in is never
   added by whoever is at an unlocked computer), then links Google to the person who pressed it and emails "Google
   sign-in was added to your Proofline account" to the account's address. If the Google address is the same as the
   account's and Google is the authority for it (below), the email also counts as confirmed.
2. **Invite page**: a live invite is accepted with Google (no password needed); a dead invite goes back to the
   invite page.
3. **A Google account already linked** always signs in as the account it is linked to — never anyone else.
4. **Same email as an existing account**: only when Google is the authority for that address (a Gmail address, or a
   Google Workspace account on its own domain) — for any other address Google's "verified" flag can be stale, so the
   person gets the generic refusal. Even then Google **never takes over an account that has a password**: anyone can
   create an account in someone else's Gmail address and wait, so the address's owner is told "There's already a
   Proofline account with that email. Sign in with your password (or reset it if you've forgotten it), then turn on
   Google in My account" (`?google=use_password`). A pending invitee can join this way only while their invite still
   works; an account without a password is linked and signed in.
5. **No account**: `/signup/google` asks only for the studio name (their name is prefilled from Google). Coming from
   the sign-in page it explains "There's no Proofline account for x yet. Create your studio below, or if you edit or
   shoot for a studio, ask them to send you an invite."

Deactivated accounts, clients whose portal is off and demo studio accounts are refused with the same words as a wrong
password. Cancelled, expired, failed, unverified-email and "linked to another account" round trips land back on the
page the person came from with a plain message at the TOP of the page (`?google=<result>`). With Google switched off the buttons are not
shown, and an old Google link lands on the page with "Continue with Google isn't available right now"
(`?google=disabled`).

## 2. Account states

| State | Column(s) | What it means |
|---|---|---|
| Invite pending | `accepted_at IS NULL`, `has_password = false` | Invited, link not opened yet. Cannot sign in (the one generic "Incorrect email or password"). Signing up with that email points them at the invite link. |
| Active | `is_active`, `accepted_at` set | Can sign in. |
| Email not confirmed | `email_verified_at IS NULL` | Only matters when email is set up: a quiet banner "Please confirm your email. We sent a link to x. [Send again] [Change email]", a "Not confirmed yet · Send again" chip on My account, and invites this person sends go out as copyable links only ("Your invite wasn't emailed because your own email isn't confirmed yet. Copy the link below and send it yourself, or confirm your email first."). Without email set up nothing about it is shown. |
| Google-only | `has_password = false`, `google_sub` set | Signs in with Google. My account offers "Set a password" (and changing the email waits until a password exists). Google can only be disconnected once a password exists. If Google sign-in is later switched off, Forgot password gives them a password. |
| Deactivated / anonymised | `is_active = false` / `anonymised_at` | No way in (password and Google both refused with the generic message). Anonymising also clears the Google link and the password. |

Every person who had joined before this feature counts as confirmed (migration 0007), so nobody is nagged; people
invited but not joined yet do not (migration 0008 — opening the link later doesn't prove the address on its own).

## 3. Email confirmation

- Sign-up sends "Confirm your email" (24-hour link `/verify-email?token=…`). "Send again" (the banner, the chip on
  My account, or the link page while signed in) issues a fresh link and the older ones stop working; at most 5 an
  hour ("Try again in N minutes").
- The link page confirms on a **button press** (`POST /api/auth/verify-email`), never on opening the page — mail
  scanners open links. It works signed in or out and never signs anyone in. Each outcome has a plain next step:
  confirmed (Continue), already used / already confirmed ("you're all set"), replaced by a newer link, expired,
  broken link (check you copied the whole link), and too many tries. Signed in, the dead-link states offer "Send a
  new link"; signed out, "Sign in to get a new link".
- Completing a password reset, confirming an email change and signing in with Google (same, Google-authoritative
  address) also confirm the email. Accepting an invite does only when the inviter's own email is confirmed and email
  is set up; otherwise "Confirm your email" goes out right after joining.
- Any email change makes the address unconfirmed again until proven (an admin changing someone's email included), and
  every link still waiting in the OLD mailbox stops working — confirm, email-change and password-reset links (and, for
  someone who hasn't joined yet, their invite link: the People page then offers "Send a new link").
- Without a mail provider: in **production** nothing is issued and nothing is shown. In **development** (not
  production) a link IS issued and handed back as a dev-only `devLink` (the sign-up response and "Send again"), so the
  flow can be walked locally and by e2e; it is never shown or returned in production.

## 4. My account (Settings → My account; clients: My account in the portal)

Profile first (name, colour; "Change your email or password further down"), then four cards, then notifications and
appearance:

- **Email** (`#email`): the address with "Confirmed" / "Not confirmed yet · Send again" (only when email is set up).
  **Change email** = the new address + your current password. With email set up a link goes to the NEW address and a
  notice to the OLD one; the card shows "Waiting for you to confirm <new> · [Send again] [Cancel change]" and the
  address only changes when the link is pressed on `/change-email` (then the old address gets "Your Proofline email
  was changed"). If someone else takes the address meanwhile, the change is closed and the person is told plainly.
  Changing your password cancels a waiting change. Without email set up the change applies at once (the new address
  is unconfirmed). A Google-only account is told to set a password first.
- **Password** (`#password`): change it (current + "Type it again"; "Changing it logs you out everywhere else. You stay
  signed in here."; "Your password was changed" email), or **Set a password** if you signed up with Google ("A
  password was added" email; nobody is logged out). There is no current password to ask for, so setting one needs a
  sign-in on this browser within the last 15 minutes; otherwise the card says "For your safety, sign in again
  (Continue with Google) before adding a password" with the Google button.
- **Google** (`#google`): "Connected as <address>" + Disconnect (only when you have a password), or Connect Google —
  which asks for your password first, then opens Google ("Google sign-in was added" goes to your address). Shown when
  Google sign-in is set up or the account is connected; when it is switched off but connected, it says so (and asks
  for a password if there is none).
- **Other devices** (`#devices`): **Log out of other devices** (one confirm, same words on the button, the dialog title
  and its confirm button) — every other browser and phone is logged out; this one stays. The card also says that
  "Log out" in the menu logs you out everywhere, this device included.
- Wrong current passwords (change password / change email / Connect Google) are limited together: 10 per 15 min
  ("Too many wrong passwords. Try again in N minutes."); a wrong one reads "That password isn’t right". Email
  changes: 5 an hour. After a failed save the cursor goes back to the first field with a problem.
- In the demo studio the whole section is one read-only notice ("…can't be changed here. [Create your own studio]").
- Everything is recorded in Settings → History (Sign-in / People): `user.email_confirmation_sent`,
  `user.email_confirmed`, `user.email_change_requested` / `_cancelled`, `user.email_changed`,
  `user.password_changed`, `user.google_connected` / `_disconnected`, `auth.other_sessions_revoked`, `auth.logged_in`
  (with `method`: password / google / demo …), `auth.login_failed`.

## 5. Sessions

- 30-day sliding sessions: once the cookie is more than 24 hours old, `src/proxy.ts` quietly re-issues it on the
  next page view, so an active person stays signed in and an unused session ends after 30 days. Renewal happens only
  on GET / HEAD requests (pages, redirects and non-auth API reads) — never on POST / PATCH / PUT / DELETE, never under
  `/api/auth/*`, and never on `?expired=1` — because those are the requests whose own handler sets or clears the
  cookie (a renewed cookie must never overwrite a sign-in or sign-out).
- Changing / resetting the password, "Log out of other devices", deactivation and role changes end every other
  session at once (`users.session_version`). "Log out" ends every session of the account — the screens say so —
  except in the demo studio, where it only logs this browser out (the persona accounts are shared by every visitor).
  After logging out the sign-in page says "You’re logged out."; a browser whose sign-in ended elsewhere sees "You’ve
  been logged out on this device. Sign in again to carry on."
- **Known devices**: every real sign-in (password, Google, joining, a reset, creating a studio — never the demo
  buttons) leaves a signed, httpOnly cookie (`pl_known_device`, 180 days; a random id and a keyed hash of the
  address, never the address). Logging out keeps it. Such a browser's wrong passwords are counted on their own, so
  strangers guessing at an address from anywhere can never lock its owner out of a browser they already use.
- Every response the proxy handles says it may not be shown inside another site (`X-Frame-Options: DENY`,
  `frame-ancestors 'none'`), `nosniff`, and sends only the origin to other sites (`Referrer-Policy`).

## 6. Rate limits (Postgres-backed table `auth_rate_limits`, shared by every server instance)

| What | Limit | The 429 says |
|---|---|---|
| Wrong password at sign-in | 5 per 15 min per email + network, and 20 per 15 min per email from anywhere — or, on a browser that has signed in to that address before, 5 per 15 min for that browser only; plus 100 per 15 min per known network, any address | "Too many sign-in attempts. Try again in N minutes." + "Or reset your password now — you can sign in with the new one straight away." (a reset clears it) |
| Create your studio (email or Google) | 5 per hour per network (per email when the network is unknown); a bot's honeypot attempt counts too, and so does a form with mistakes whose email would be looked up ("already in use" / "invited" is only answered inside the limit) | "Too many new studios from this network. Try again in N minutes." |
| Forgot password | 5 per 15 min per email + network | "Too many reset emails asked for. Try again in N minutes." |
| Reset link that no longer works | 10 per 15 min per network (only when the network is known; checked before the new password is hashed) | "Too many tries with reset links that no longer work. Try again in N minutes." |
| "Send again" (confirm link) | 5 per hour per person | "Try again in N minutes" |
| Change email (request + "Send again") | 5 per hour per person | "Too many email changes asked for. Try again in N minutes." |
| Wrong current password (change password / email) | 10 per 15 min per person | "Too many wrong passwords. Try again in N minutes." |
| Google sign-in callbacks | 30 per 15 min per network (not counted when the network is unknown) | back on the page: "We couldn't finish with Google just now. Wait a moment, then try again." |
| Demo sign-in | 30 per 10 min per network (not counted when the network is unknown) | "Too many demo sign-ins from this network. Try again in N minutes." |

Every 429 also carries `retry-after` and `details.retryAfterSeconds`. "Network" is the client IP, which the app only
trusts behind a known proxy: set `TRUSTED_PROXY_COUNT=1` on Vercel. Without it the per-network limits are never one
bucket shared by every visitor: sign-in and forgot-password count per email, sign-up per email, and the reset-link,
demo and Google-callback limits are skipped; a production server on Vercel logs a warning once. The counts are
stored as keyed hashes (HMAC with the session secret) — never an email or an IP.

## 7. The demo studio

The seeded Northlight studio (and the isolation studio) carry `organisations.is_demo` (the seed sets it as its last
step; `SEED_DEMO=off` skips it — the e2e database does). In a demo studio:

- no email is ever sent; invites are turned off — Settings → People shows a disabled **Invite someone** with
  "Invites are turned off in the demo studio", a client's Online access says the same, and the send / revoke / reset
  controls are hidden;
- nobody can change a password, an email or a sign-in method, log out other devices, reset someone's password, or
  hand over the primary owner; the four demo people can't be deactivated, re-roled, given or denied switches, or
  anonymised, and the Client persona's client can't have its online access switched off or be archived (that would
  lock every visitor out of "Look around as Client"). The services refuse all of it with a plain 403 even if a screen
  offered it (and the screens don't offer it);
- nobody can join through an invite link of a demo studio (links made before it became the demo were closed by
  migration 0008);
- Forgot password creates no link for a demo person, and a reset link for one is "no longer valid";
- a banner says "You're looking at the demo studio. Anyone can see changes here. [Create your own studio]" (the
  button signs this browser out and opens `/signup`);
- the sign-in page never shows demo emails or passwords — the "Look around the demo" buttons sign you in as a person
  (`POST /api/auth/demo`). `DEMO_SIGN_IN=off` closes the demo studio: the buttons are hidden, the endpoint answers
  404, the landing page stops offering the demo, and its people can't sign in with a password or Google either (the
  seeded password is public). The panel is also hidden on `/login?from=invite` and in a browser that has created a
  real studio, unless `?demo=1` asks for it.

## 8. Owner setup checklist (production)

Everything below is optional: without it Proofline still works (links are shown to copy, Google is hidden, the
confirm-your-email feature is invisible).

**A. Real email (Resend)** — needed for confirm links, account notices, emailed invites and password resets.
1. Create an account at resend.com. Add your domain (e.g. `mail.yourstudio.com`) under Domains.
2. Add the DNS records Resend shows (SPF `TXT`, DKIM `CNAME`/`TXT`, optional DMARC) at your DNS provider; wait for
   "Verified".
3. Create an API key (Sending access).
4. In Vercel → Project → Settings → Environment Variables (Production): `RESEND_API_KEY` = the key, `EMAIL_FROM` =
   `Proofline <hello@mail.yourstudio.com>` (an address on the verified domain), `APP_URL` =
   `https://photographer-workmanagement.vercel.app` (or your custom domain — links in emails use it).
5. Redeploy. Settings → Studio's email card should say emails are sent. From then on new owners see "Please confirm
   your email" until they press the link (existing people already count as confirmed).

**B. Continue with Google**
1. console.cloud.google.com → create (or pick) a project.
2. APIs & Services → OAuth consent screen: User type **External**; app name "Proofline", support email, your logo
   (optional); scopes: `openid`, `email`, `profile` (nothing sensitive, so no Google review is needed); publish the app
   ("In production") so anyone can sign in.
3. APIs & Services → Credentials → Create credentials → OAuth client ID → **Web application**. Authorised redirect URIs:
   - `https://photographer-workmanagement.vercel.app/api/auth/google/callback`
   - `http://localhost:3130/api/auth/google/callback` (local development)
   (Add your custom domain's `/api/auth/google/callback` too if you use one; it must match `APP_URL` exactly.)
4. Vercel env vars (Production): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Locally: the same two in `.env.local`.
5. Redeploy. "Continue with Google" appears on sign-in, sign-up and invite pages, and the Google card on My account.
6. Try it once end to end (nothing in the automated tests talks to the real Google): sign in with a Gmail account
   that has no Proofline account (→ "Create your studio"), connect Google on an existing account, disconnect it,
   and accept an invite with Google.

**C. Demo studio and limits**
- `TRUSTED_PROXY_COUNT=1` in Vercel so rate limits count per visitor (the server logs a warning while it is missing).
- `DEMO_SIGN_IN=off` in Vercel closes the demo studio (e.g. once you no longer want public demo access): no buttons,
  and its shared accounts can't sign in at all. With it on, the buttons only appear when the database actually has a
  demo studio (the seeded one).

**D. Database migrations on deploy**
- Only **Production** deploys apply `./drizzle` to the database (`scripts/vercel-migrate.mjs` checks `VERCEL_ENV`).
  There is one database: a Preview build of a branch must never migrate it before the branch is merged. Keep
  `DIRECT_URL` out of Vercel's Preview environment anyway (or set `MIGRATE_ON_BUILD=1` only for a preview with its
  own database). An applied migration file is never edited again — fixes go in a new one.
- Before the first deploy of this feature, look for strangers a visitor invited into the live demo studio (read-only:
  `SELECT o.slug, u.email FROM users u JOIN organisations o ON o.id = u.organisation_id WHERE o.is_demo AND u.email NOT
  LIKE '%@studio.test' AND u.email NOT LIKE '%@other.test';`) and deactivate + anonymise them; migration 0008 already
  closes their invite links.

## 9. Environment variables

| Variable | Needed for | Default / without it |
|---|---|---|
| `SESSION_SECRET` (≥ 32 chars) | signing sessions and the Google round-trip cookies | required in production; dev generates `data/.session-secret` |
| `APP_URL` | links in emails, the Google redirect URI | production: required for correct links; dev: the request's own address |
| `RESEND_API_KEY` + `EMAIL_FROM` | real email | off: links shown to copy, email confirmation invisible (dev: dev-only links) |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Continue with Google | off: no Google buttons; `/api/auth/google/start` and `/callback` send the browser back with `?google=disabled` |
| `DEMO_SIGN_IN` | `off` (also `false` / `0` / `no`) closes the demo studio (no buttons; its accounts can't sign in) | on |
| `TRUSTED_PROXY_COUNT` | per-visitor rate limits behind Vercel (`1`) | 0: forwarding headers ignored |
| `SEED_DEMO` | `off` seeds ordinary studios (the e2e database does) | on (the seeded studios are demo studios) |
| `MIGRATE_ON_BUILD` | `1` lets a non-production Vercel build run `drizzle-kit migrate` (only for a preview with its own database) | production deploys only |

## 10. Not built (on purpose, for now)

- One email in several studios — an email address belongs to exactly one account (emails stay globally unique).
- Two-factor authentication.
- A list of signed-in devices (only "Log out of other devices"), a "log out this device only" choice (Log out ends
  every session; a per-device revoke would need a session table), or a "keep me signed in" choice (sessions are
  always 30-day sliding).
- Deleting an account or a studio (people are deactivated / anonymised by the owner).
- Terms of service / privacy pages.
- Captcha (the sign-up honeypot and the rate limits are the bot defence).
- Refreshing the shown Google address when someone changes it at Google (reconnecting updates it).
- A "switch person" control inside the demo studio (sign out, then pick another person on the sign-in page).
