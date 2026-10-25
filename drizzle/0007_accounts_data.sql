-- Accounts (docs/ACCOUNTS.md; contract docs/ACCOUNTS-PLAN.md §1). Custom migration that follows the generated
-- DDL in 0006_accounts.sql (drizzle-kit generate --name accounts): idempotent backfills, CHECK constraints and the
-- auth_tokens fill-once guard update. ADDITIVE ONLY: nothing is dropped, no row is deleted; safe on live data.
-- Statements are separated by drizzle's statement-breakpoint marker (same style as 0003 / 0005).

-- (a) Email confirmation: every user that exists before the feature shipped counts as confirmed (they predate it;
--     never nag existing people): email_verified_at = COALESCE(accepted_at, created_at). Re-run guard: once the
--     feature has issued any email_verify / email_change link, people who signed up since must stay unconfirmed,
--     so the statement becomes a no-op.
UPDATE users SET email_verified_at = COALESCE(accepted_at, created_at)
 WHERE email_verified_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM auth_tokens t WHERE t.kind IN ('email_verify', 'email_change'));
--> statement-breakpoint

-- (b) has_password: false where the stored hash is not a bcrypt hash (link-invitees who have not accepted yet
--     carry '!invite!…', anonymised accounts '!anonymised!…'). Idempotent.
UPDATE users SET has_password = false WHERE has_password AND password_hash NOT LIKE '$2%';
--> statement-breakpoint

-- (c) Demo studios: the seeded Northlight and the isolation org (the "small" and the "full" seed both use these
--     two slugs), and only when one of their members has a seeded demo address — a real sign-up can never match.
--     From now on the seed sets is_demo when it creates them. Idempotent.
UPDATE organisations o SET is_demo = true
 WHERE NOT o.is_demo
   AND o.slug IN ('northlight', 'other-studio')
   AND EXISTS (SELECT 1 FROM users u
                WHERE u.organisation_id = o.id
                  AND (u.email LIKE '%@studio.test' OR u.email LIKE '%@other.test'));
--> statement-breakpoint

-- (d) CHECK constraints. Every existing row satisfies them (only 'invite' / 'password_reset' tokens exist so far
--     and the new columns are all NULL).
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_kind_ck;
--> statement-breakpoint
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_kind_ck
  CHECK (kind IN ('invite', 'password_reset', 'email_verify', 'email_change'));
--> statement-breakpoint
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_target_email_ck;
--> statement-breakpoint
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_target_email_ck
  CHECK ((kind IN ('email_verify', 'email_change')) = (target_email IS NOT NULL));
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_google_pair_ck;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_google_pair_ck CHECK ((google_sub IS NULL) = (google_email IS NULL));
--> statement-breakpoint

-- (e) auth_tokens stays a fill-once ledger: the new target_email column is immutable like every column but
--     used_at. Same trigger (at_fill_once, 0005), new function body.
CREATE OR REPLACE FUNCTION guard_at_fill_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.target_email IS DISTINCT FROM OLD.target_email
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'auth token rows are immutable except used_at (fill-once)';
  END IF;
  RETURN NEW;
END;
$$;
