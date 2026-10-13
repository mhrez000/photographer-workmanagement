-- Simplified UI (docs/SIMPLIFICATION-PLAN.md §8, §10 phase 4): the Advanced tools switch and two optional
-- fields. Generated DDL first (drizzle-kit generate --name simplify), then the data rule.
ALTER TABLE "job_types" ADD COLUMN "usual_days_to_edit" integer;--> statement-breakpoint
ALTER TABLE "organisation_settings" ADD COLUMN "advanced_tools_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "usual_capacity_jobs" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "simpler_notice_dismissed_at" text;--> statement-breakpoint

-- Safety for existing studios (plan §8): Advanced tools turns ON automatically for an organisation that
--   (a) has a NON-DEFAULT workflow bound to a job type that has jobs (a custom workflow in use), or
--   (b) has any enabled, non-archived automation.
-- Nothing else changes: the pages stay exactly as they were for those studios. Audited with one
-- settings.updated event per organisation (actor NULL, cause "migration"), append-only like every event.
WITH needs_advanced AS (
  SELECT s.organisation_id
    FROM organisation_settings s
   WHERE NOT s.advanced_tools_enabled
     AND (
       EXISTS (SELECT 1 FROM job_types jt
                 JOIN workflows w ON w.id = jt.workflow_id
                WHERE jt.organisation_id = s.organisation_id
                  AND NOT w.is_default
                  AND EXISTS (SELECT 1 FROM jobs j WHERE j.job_type_id = jt.id))
       OR EXISTS (SELECT 1 FROM automations a
                   WHERE a.organisation_id = s.organisation_id AND a.is_enabled AND a.archived_at IS NULL)
     )
),
ev AS (
  INSERT INTO activity_events (id, organisation_id, actor_user_id, job_id, entity_type, entity_id, event_type, action,
                               previous_value, new_value, metadata, summary, visibility, created_at)
  SELECT 'mig' || replace(gen_random_uuid()::text, '-', ''), n.organisation_id, NULL, NULL, 'settings', n.organisation_id,
         'settings.updated', 'updated',
         jsonb_build_object('field', 'advancedToolsEnabled', 'value', false),
         jsonb_build_object('field', 'advancedToolsEnabled', 'value', true),
         jsonb_build_object('cause', 'migration', 'migration', '0004_simplify', 'field', 'advancedToolsEnabled',
                            'reason', 'uses_custom_workflow_or_automations'),
         'turned on Advanced tools automatically: this studio uses a custom workflow or automations',
         'management', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    FROM needs_advanced n
   WHERE NOT EXISTS (SELECT 1 FROM activity_events x WHERE x.organisation_id = n.organisation_id
                       AND x.event_type = 'settings.updated' AND x.metadata->>'migration' = '0004_simplify')
  RETURNING entity_id)
UPDATE organisation_settings s
   SET advanced_tools_enabled = true, version = version + 1,
       updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 WHERE s.organisation_id IN (SELECT entity_id FROM ev);
--> statement-breakpoint

-- Studios that rely on automation "notify" actions keep hearing them: the `automation` notice is now OFF
-- by default (plan §8), so every active staff member of an organisation with an enabled automation gets an
-- explicit "on" preference row (exactly what My account → Notifications would write). Idempotent.
INSERT INTO user_notification_prefs (id, organisation_id, user_id, type, enabled, updated_at)
SELECT 'mig' || replace(gen_random_uuid()::text, '-', ''), u.organisation_id, u.id, 'automation', true,
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  FROM users u
 WHERE u.is_active AND u.role IN ('photographer', 'editor')
   AND EXISTS (SELECT 1 FROM automations a WHERE a.organisation_id = u.organisation_id AND a.is_enabled AND a.archived_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM user_notification_prefs p WHERE p.user_id = u.id AND p.type = 'automation');
