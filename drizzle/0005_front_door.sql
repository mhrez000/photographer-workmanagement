CREATE TABLE "auth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_user_id" text,
	"expires_at" text NOT NULL,
	"used_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organisation_settings" ADD COLUMN "onboarding_dismissed_at" text;--> statement-breakpoint
ALTER TABLE "organisation_settings" ADD COLUMN "email_notifications_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_at" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "accepted_at" text;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_hash_uq" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_tokens_user_kind_idx" ON "auth_tokens" USING btree ("user_id","kind","used_at");--> statement-breakpoint
CREATE INDEX "auth_tokens_org_idx" ON "auth_tokens" USING btree ("organisation_id","created_at");--> statement-breakpoint

-- Front door (sign-up, invite links, password reset). Generated DDL above (drizzle-kit generate --name front_door),
-- then the data rule and the guards below (drizzle-kit does not model triggers; same style as 0001_guards.sql).

-- Every user that exists before this migration has a usable password (demo seed, temp-password invites), so they
-- count as "accepted". From now on only an accepted user may sign in; an invited user stays NULL until they set
-- their own password through the invite link. Idempotent.
UPDATE users SET accepted_at = created_at WHERE accepted_at IS NULL;
--> statement-breakpoint

/* ---------------- auth_tokens: used_at fill-once; everything else immutable; append-only ---------------- */
DROP TRIGGER IF EXISTS at_no_delete ON auth_tokens;
--> statement-breakpoint
CREATE TRIGGER at_no_delete BEFORE DELETE ON auth_tokens
  FOR EACH ROW EXECUTE FUNCTION guard_reject('auth_tokens is append-only (tokens expire or are marked used)');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_at_fill_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'auth token rows are immutable except used_at (fill-once)';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS at_fill_once ON auth_tokens;
--> statement-breakpoint
CREATE TRIGGER at_fill_once BEFORE UPDATE ON auth_tokens
  FOR EACH ROW EXECUTE FUNCTION guard_at_fill_once();
--> statement-breakpoint
DROP TRIGGER IF EXISTS at_no_truncate ON auth_tokens;
--> statement-breakpoint
CREATE TRIGGER at_no_truncate BEFORE TRUNCATE ON auth_tokens
  FOR EACH STATEMENT EXECUTE FUNCTION guard_reject('auth_tokens is append-only (tokens expire or are marked used)');
