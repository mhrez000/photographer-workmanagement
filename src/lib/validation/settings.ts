/** Zod inputs for the organisation settings service (ARCHITECTURE.md §2.1, docs/ROLES.md §1.2, §4.3). */
import { z } from "zod";
import { ExpectedVersionSchema, IdSchema, NameSchema } from "./admin-shared";

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const num = (min: number, max: number) => z.number().min(min).max(max);

/** Every editable organisation_settings column (camelCase) with its rule. */
export const SettingsFieldSchemas = {
  timezone: z.string().trim().min(1).max(64).refine(isValidTimeZone, "Unknown time zone"),
  weekStartsOn: int(0, 6),
  jobNumberPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9]{0,7}$/, "Use 1–8 letters or digits, starting with a letter"),
  timeTrackingEnabled: z.boolean(),
  workSessionAutoTimeoutMinutes: int(15, 24 * 60),
  defaultCapacityHoursPerWeek: num(1, 168),
  defaultEstimatedHours: num(0.1, 500),
  workloadNearCapacityRatio: num(0.05, 5),
  workloadOverloadedRatio: num(0.05, 10),
  maxActiveJobsPerEditor: int(1, 500),
  reviewBottleneckHours: int(1, 24 * 30),
  reviewBottleneckMinJobs: int(1, 1000),
  editingBottleneckDueWithinHours: int(1, 24 * 30),
  editingBottleneckMinDueSoon: int(1, 1000),
  unassignedBacklogMin: int(1, 10000),
  stalledDays: int(1, 365),
  revisionSpikeMinCount: int(1, 10000),
  revisionSpikeMultiplier: num(1, 20),
  reviewSlaHours: int(1, 24 * 30),
  // Roles v2: the four org-wide visibility switches (photographersSeeAllJobs, photographersSeeTeamJobs,
  // editorsSeeTeamJobs, editorsSeeTeamWorkloads) are deprecated columns replaced by per-user switches;
  // they are no longer editable (unknown key → 400).
  automationsEnabled: z.boolean(),
  auditNotifications: z.boolean(),
  /**
   * Photographer pre-filled on jobs editors create (§4.3); null = the primary
   * owner. The service requires an active photographer of the organisation.
   */
  defaultPhotographerUserId: IdSchema.nullable(),
  /** Settings → Studio → Advanced tools (SIMPLIFICATION-PLAN §8). Audited like every other field. */
  advancedToolsEnabled: z.boolean(),
} as const;

export type SettingsField = keyof typeof SettingsFieldSchemas;
export const SETTINGS_FIELDS = Object.keys(SettingsFieldSchemas) as SettingsField[];

const partialFields = Object.fromEntries(
  SETTINGS_FIELDS.map((k) => [k, SettingsFieldSchemas[k].optional()]),
) as { [K in SettingsField]: z.ZodOptional<(typeof SettingsFieldSchemas)[K]> };

export const UpdateSettingsInput = z
  .object({
    expectedVersion: ExpectedVersionSchema,
    /** organisations.name (audited as field "organisationName"). */
    organisationName: NameSchema(120).optional(),
    ...partialFields,
  })
  .strict();
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInput>;

/** POST /api/settings/roles-notice/dismiss { expectedVersion? } (§1.5). */
export const DismissRolesNoticeInput = z.strictObject({ expectedVersion: ExpectedVersionSchema });
export type DismissRolesNoticeInput = z.infer<typeof DismissRolesNoticeInput>;
