ALTER TABLE "clients" ADD COLUMN "portal_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "feedback_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job_links" ADD COLUMN "shared_with_client" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job_links" ADD COLUMN "added_by_sharer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "created_by_role" text DEFAULT 'photographer' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "shared_with_client" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organisation_settings" ADD COLUMN "primary_owner_user_id" text;--> statement-breakpoint
ALTER TABLE "organisation_settings" ADD COLUMN "default_photographer_user_id" text;--> statement-breakpoint
ALTER TABLE "organisation_settings" ADD COLUMN "roles_v2_notice_dismissed_at" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "shared_with_client" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "can_create_jobs" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "can_view_all_jobs" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "can_assign_editors" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "can_review_submissions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "can_view_team_jobs" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "organisation_settings" ADD CONSTRAINT "organisation_settings_primary_owner_user_id_users_id_fk" FOREIGN KEY ("primary_owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_settings" ADD CONSTRAINT "organisation_settings_default_photographer_user_id_users_id_fk" FOREIGN KEY ("default_photographer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_org_client_idx" ON "users" USING btree ("organisation_id","client_id");