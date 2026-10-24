-- Accounts hardening (the review fixes; docs/ACCOUNTS-PLAN.md §8 "Review fixes"). Custom migration after
-- 0007_accounts_data.sql. 0006 / 0007 are FROZEN: an environment may already have applied them, and drizzle never
-- re-runs an applied file, so every later change goes here. ADDITIVE ONLY: no row is deleted, nothing is dropped
-- except a CHECK that is re-added wider; every statement is idempotent (re-running the file changes nothing).
-- Statements are separated by drizzle's statement-breakpoint marker (same style as 0003 / 0005 / 0007).
-- Timestamps: to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') (ISO-8601 UTC like the app).

-- (a) DATA-02: anonymising a person scrubs the addresses their links carried (auth_tokens.target_email). The address
--     stays REQUIRED on an unused email_verify / email_change link (a confirm link only works for the address it went
--     to), may be cleared once the link is used up, and stays NULL for the other kinds.
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_target_email_ck;
--> statement-breakpoint
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_target_email_ck
  CHECK (CASE WHEN kind IN ('email_verify', 'email_change') THEN target_email IS NOT NULL OR used_at IS NOT NULL ELSE target_email IS NULL END);
--> statement-breakpoint

-- (b) The fill-once guard (trigger at_fill_once, 0005), one new allowance: target_email may go from an address to NULL
--     once the row is used (or in the very statement that uses it up) — a one-way scrub, never to another address.
--     Everything else as 0007: every other column immutable, used_at fill-once, a used row otherwise frozen (no
--     delete / truncate: at_no_delete / at_no_truncate are unchanged).
CREATE OR REPLACE FUNCTION guard_at_fill_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
    OR (NEW.target_email IS DISTINCT FROM OLD.target_email AND NOT (NEW.target_email IS NULL AND NEW.used_at IS NOT NULL))
    OR (OLD.used_at IS NOT NULL AND NEW.target_email IS NOT DISTINCT FROM OLD.target_email)
  THEN
    RAISE EXCEPTION 'auth token rows are immutable except used_at (fill-once)';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- (c) DATA-05: a demo studio's invite links that are still live stop working. Before the demo was flagged (0007 c),
--     any visitor could act as its owner and invite real addresses; those links must not open a real account inside a
--     studio every visitor can enter (the code now also refuses accepting any invite of a demo studio). Fill-once:
--     only unused, unexpired links are touched.
UPDATE auth_tokens SET used_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 WHERE kind = 'invite'
   AND used_at IS NULL
   AND expires_at > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   AND organisation_id IN (SELECT id FROM organisations WHERE is_demo);
--> statement-breakpoint

-- (d) DATA-04: has_password follows the stored hash again. Code that predates 0006 (the deploy window, a failed build,
--     a preview that migrated early) inserts has_password = true (the column default) for link-invitees, whose hash is
--     '!invite!…'. The app now decides from the hash itself; this re-syncs the flag both ways. Idempotent.
UPDATE users SET has_password = (password_hash LIKE '$2%')
 WHERE has_password IS DISTINCT FROM (password_hash LIKE '$2%');
--> statement-breakpoint

-- (e) SEC-05: opening an invite link does not prove the address (the inviter can always copy the link), so 0007 (a)
--     must not have marked people who have NOT joined yet as confirmed. Nobody who has not joined can have confirmed
--     their address any other way (they cannot sign in). Idempotent.
UPDATE users SET email_verified_at = NULL
 WHERE accepted_at IS NULL
   AND email_verified_at IS NOT NULL;
