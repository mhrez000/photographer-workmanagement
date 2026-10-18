/**
 * Plain-English copy for the roles v2 permission model (docs/ROLES.md §2.2,
 * §6.1, §11). Pure — shared by the invite dialog, the user detail page, the
 * Roles page and the profile "Your access" card.
 */
import {
  EDITOR_FLAGS,
  MEMBER_FLAGS,
  type EditorFlag,
  type MemberFlag,
  type Persona,
} from "@/lib/constants";

export type BadgeVariant = "solid" | "info" | "neutral" | "outline";

/** Persona badge variants (§11): admin solid, member info, editor neutral, client outline. */
export const PERSONA_BADGE: Record<Persona, BadgeVariant> = {
  admin: "solid",
  member: "info",
  editor: "neutral",
  client: "outline",
};

export type MemberFlagValues = Record<MemberFlag, boolean>;
export type EditorFlagValues = Record<EditorFlag, boolean>;

/** What each switched-on member flag lets them do, as a clause after "They'll be able to:". */
const MEMBER_ABILITY: Record<MemberFlag, string> = {
  canCreateJobs: "create jobs",
  canAssignEditors: "assign editors on their jobs",
  canReviewSubmissions: "review, deliver and complete their jobs",
  canViewTeamWorkloads: "see team workload",
  canViewAllJobs: "see every job in the business",
  canViewAnalytics: "see analytics and reports",
};

const EDITOR_ABILITY: Record<EditorFlag, string> = {
  canCreateJobs: "create jobs for a photographer",
  canViewTeamJobs: "see other editors' jobs (read-only)",
};

function joinClauses(parts: string[]): string {
  return parts.join(", ");
}

/**
 * Live summary under the invite / permission switches (§2.2):
 * "They'll be able to: create jobs, assign editors on their jobs. Reviews of their jobs come to you."
 */
export function memberAccessSummary(flags: MemberFlagValues, opts: { isAdmin?: boolean } = {}): string {
  if (opts.isAdmin) {
    return "They'll be able to do everything you can: every job, person and setting, except change the primary owner.";
  }
  const on = MEMBER_FLAGS.filter((f) => flags[f]).map((f) => MEMBER_ABILITY[f]);
  const head = on.length > 0 ? `They'll be able to: ${joinClauses(on)}.` : "They'll be able to see and work on their own jobs only.";
  const tail: string[] = [];
  if (!flags.canAssignEditors) tail.push("You assign editors to their jobs.");
  if (!flags.canReviewSubmissions) tail.push("Reviews of their jobs come to you.");
  return [head, ...tail].join(" ");
}

/** Editor equivalent: "They'll edit the jobs assigned to them and can: create jobs for a photographer." */
export function editorAccessSummary(flags: EditorFlagValues): string {
  const on = EDITOR_FLAGS.filter((f) => flags[f]).map((f) => EDITOR_ABILITY[f]);
  return on.length > 0
    ? `They'll edit the jobs assigned to them and can: ${joinClauses(on)}.`
    : "They'll see and edit only the jobs assigned to them.";
}

/**
 * "Copy invite message" text (§6.1). Client invites use /login too; they land on /portal.
 */
export function inviteMessage(input: { studio: string; origin: string; email: string; password: string }): string {
  const origin = input.origin.replace(/\/+$/, "");
  return `You've been invited to ${input.studio} on Proofline. Sign in at ${origin}/login with ${input.email} and the temporary password ${input.password}. You'll be asked to choose a new password.`;
}

/** "Copy message" text for a LINK invite (the default, front door): the link is the whole secret. */
export function inviteLinkMessage(input: { studio: string; inviteUrl: string; name?: string | null }): string {
  const first = input.name?.trim().split(/\s+/)[0];
  return `${first ? `Hi ${first}, ` : ""}you've been invited to ${input.studio} on Proofline. Open ${input.inviteUrl} to choose your password and sign in. The link works for 7 days.`;
}

/** Picks the member flags out of any object carrying them (a user row, an AuthContext…). */
export function memberFlagsOf(source: Partial<Record<MemberFlag, boolean | null | undefined>>): MemberFlagValues {
  return Object.fromEntries(MEMBER_FLAGS.map((f) => [f, source[f] === true])) as MemberFlagValues;
}

/** Picks the editor flags out of any object carrying them. */
export function editorFlagsOf(source: Partial<Record<EditorFlag, boolean | null | undefined>>): EditorFlagValues {
  return Object.fromEntries(EDITOR_FLAGS.map((f) => [f, source[f] === true])) as EditorFlagValues;
}
