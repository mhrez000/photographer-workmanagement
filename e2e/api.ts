/**
 * The e2e helper module: server URL, seeded accounts, a thin REST client and
 * data factories (src/app/api/README.md is the contract).
 *
 * Every spec builds the data it needs through these helpers with unique names
 * and asserts on those entities only, so specs never depend on seeded counts,
 * on each other, or on other people using the same dev database. Seeded demo
 * accounts are only ever signed in through their own cookie jars — never
 * logged out, deactivated or archived (logout / deactivation tests use users
 * the spec invites).
 */
import path from "node:path";
import { request as playwrightRequest, type APIRequestContext, type APIResponse } from "@playwright/test";

/* ------------------------------ environment ----------------------------- */

/** `E2E_BASE_URL` (an already-running server) or Playwright's own server on :3100. */
export const BASE_URL = process.env.E2E_BASE_URL?.trim() || "http://localhost:3100";
export const DEMO_PASSWORD = "Password123!";
/** The seeded organisation's timezone (src/db/seed/catalog.ts). */
export const ORG_TIME_ZONE = "Australia/Sydney";

export function baseUrl(): string {
  return BASE_URL;
}

/** Per-role storage states (gitignored). */
export const AUTH_DIR = path.join(__dirname, ".auth");

/**
 * Storage-state file for a role or user. The worker's pid is part of the name
 * so two concurrent `playwright test` runs on one checkout never read or
 * clobber each other's sessions.
 */
export const authFile = (key: string) => path.join(AUTH_DIR, `${key}.${process.pid}.json`);

/**
 * Seeded demo accounts by persona (docs/ROLES.md §12.2, §13). Roles v2 has
 * exactly three roles (photographer, editor, client); admin is a property of a
 * photographer, and team members / editors carry permission switches.
 */
export type Role =
  /** Owner / Photographer: admin and primary owner; also shoots. */
  | "owner"
  /** Team member with every switch on (sees all jobs, workloads, analytics; reviews). */
  | "photographer"
  /** Team member with the migrated defaults: create ✓, assign ✓, review ✓; sees only jobs they manage. */
  | "photographer-noflags"
  /** Junior team member: create ✓, assign ✗, review ✗ (the owner assigns and reviews her work). */
  | "photographer-restricted"
  /** Editor at defaults (create jobs ✓, other editors' jobs ✗). */
  | "editor"
  /** Editor with "See other editors' jobs" (read-only). */
  | "editor-team"
  | "editor-overloaded"
  /** Client portal user of Harbourline Realty (portal + feedback on). */
  | "client"
  /** Client portal user of Coastal Key Property (portal on, feedback off, nothing shared). */
  | "client2"
  /** Admin of the second organisation (tenant isolation). */
  | "other-owner"
  /** Client portal user of the second organisation. */
  | "other-client";

/** Seeded demo accounts (src/db/seed/catalog.ts). Password for all: Password123!. */
export const ROLE_EMAILS: Record<Role, string> = {
  owner: "owner@studio.test",
  photographer: "photographer01@studio.test",
  "photographer-noflags": "photographer02@studio.test",
  "photographer-restricted": "photographer12@studio.test",
  editor: "editor01@studio.test",
  "editor-team": "editor02@studio.test",
  "editor-overloaded": "editor03@studio.test",
  client: "client@studio.test",
  client2: "client2@studio.test",
  "other-owner": "owner@other.test",
  "other-client": "client@other.test",
};

/** Accounts that use the client portal (never the staff shell). */
export const CLIENT_ROLES: readonly Role[] = ["client", "client2", "other-client"];
export const isClientRole = (role: Role): boolean => CLIENT_ROLES.includes(role);

/** Effective permission switches (docs/ROLES.md §2.2); `GET /api/auth/me` returns them for staff. */
export interface PermissionFlags {
  canCreateJobs: boolean;
  canViewAllJobs: boolean;
  canAssignEditors: boolean;
  canReviewSubmissions: boolean;
  canViewTeamWorkloads: boolean;
  canViewAnalytics: boolean;
  canViewTeamJobs: boolean;
}

export type ViewScope = "mine" | "business";

/** Unique, human-readable name so entities never collide between runs. */
export function uniq(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Civil date (YYYY-MM-DD) in the org timezone, `days` from today. */
export function civilDate(days = 0, timeZone = ORG_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + days * 86_400_000));
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Waits until `fn` returns a truthy value (server-side effects after a UI action). */
export async function eventually<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000, intervalMs = 400): Promise<T> {
  const start = Date.now();
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`eventually: timed out${last ? ` (last error: ${(last as Error).message})` : ""}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/* --------------------------- response shapes --------------------------- */

export interface UserRef {
  id: string;
  name: string;
}
export interface StatusRef {
  id: string;
  name: string;
  category: string;
}
export interface JobRow {
  id: string;
  jobNumber: string;
  name: string;
  client?: { id: string; name: string } | null;
  project?: { id: string; name: string } | null;
  status: StatusRef;
  statusCategory: string;
  priority: string;
  editor: UserRef | null;
  photographer: UserRef | null;
  dueDate: string | null;
  isOverdue: boolean;
  revisionCount: number;
  version: number;
}
export interface RevisionView {
  id: string;
  revisionNumber: number;
  reason: string;
  description: string;
  resolvedAt: string | null;
  resolution: string | null;
  isOpen: boolean;
  assignee: UserRef | null;
}
export interface JobDetail {
  job: JobRow & { createdBy: UserRef; completedAt: string | null; reopenedCount: number };
  revisions: RevisionView[];
  openRevision: RevisionView | null;
  actions: Record<string, unknown> & {
    transitions: { toStatus: StatusRef; label: string; isReopen?: boolean }[];
    canUseTimer: boolean;
    canComment: boolean;
  };
  finishedWork: { id: string; kind: string; url: string; addedBy: UserRef }[];
}
export interface ActivityItem {
  id: string;
  eventType: string;
  summary: string;
  sentence?: string;
  actor: UserRef | null;
  previousValue: unknown;
  newValue: unknown;
  metadata: Record<string, unknown>;
  createdAt: string;
}
export interface StageView {
  sequence: number;
  kind: string;
  toCategory: string;
  statusName: string;
  isReopen: boolean;
  isCurrent: boolean;
  actor: UserRef | null;
  editorAtEntry: UserRef | null;
  reason: string | null;
}
export interface HistoryEntry {
  at: string;
  kind: "stage" | "event";
  stage?: StageView;
  event?: ActivityItem;
}
export interface SessionView {
  id: string;
  user: UserRef;
  endedAt: string | null;
  endReason: string | null;
  isRunning: boolean;
}
export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  linkPath: string;
  job: { id: string; jobNumber: string } | null;
  readAt: string | null;
}
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}
export interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  version: number;
}
/** A user invited by a spec (`Api.inviteUser`); `tempPassword` signs in straight away. */
export interface InvitedUser {
  user: UserProfile;
  email: string;
  tempPassword: string;
}
/** `Api.inviteUser` options (docs/ROLES.md §6.1 `POST /api/users`). Omitted flags take the invite defaults. */
export interface InviteOptions {
  label?: string;
  title?: string;
  /** Photographers only: "Make admin (co-owner)". */
  isAdmin?: boolean;
  flags?: Partial<PermissionFlags>;
  /** Required for `role: "client"`: a portal-enabled client of the organisation. */
  clientId?: string;
}

/** `GET /api/auth/me` for staff (§7.7: the existing shape plus persona, admin and effective switches). */
export interface StaffMe {
  kind?: "staff";
  user: PermissionFlags & {
    id: string;
    name: string;
    email: string;
    role: string;
    persona: "admin" | "member" | "editor";
    personaLabel: string;
    isAdmin: boolean;
    isPrimaryOwner: boolean;
  };
  unreadCount: number;
}
/** `GET /api/auth/me` for a client portal user (§7.7 client-safe shape). */
export interface ClientMe {
  kind: "client";
  name: string;
  email: string;
  clientName: string;
  studioName: string;
  unreadCount: number;
}

/* ---- client portal projection (docs/ROLES.md §7.4; src/lib/types.ts Portal*) ---- */
export interface PortalLinkView {
  id: string;
  kind: string;
  label: string | null;
  url: string;
  provider: string | null;
}
export interface PortalFeedbackMessageView {
  id: string;
  body: string;
  authorName: string;
  isClient: boolean;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}
export interface PortalFeedbackThreadView extends PortalFeedbackMessageView {
  replies: PortalFeedbackMessageView[];
}
export interface PortalJobView {
  id: string;
  jobNumber: string;
  name: string;
  project: { id: string; name: string; address: string | null };
  jobTypeName: string;
  milestone: "booked" | "shot" | "editing" | "delivered" | null;
  milestoneLabel: string;
  milestoneDetail: string | null;
  updating: boolean;
  cancelled: boolean;
  shootDate: string | null;
  deliveryDueDate: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  photographer: { name: string } | null;
}
export interface PortalJobDetailView extends PortalJobView {
  links: PortalLinkView[];
  deliveryNotes: { id: string; body: string; createdAt: string; authorName: string }[];
  feedback: PortalFeedbackThreadView[];
  canGiveFeedback: boolean;
}
/** Exactly the keys §7.4 allows in a portal job detail (a whitelist projection: nothing else may appear). */
export const PORTAL_JOB_DETAIL_KEYS = [
  "canGiveFeedback",
  "cancelled",
  "cancelledAt",
  "deliveredAt",
  "deliveryDueDate",
  "deliveryNotes",
  "feedback",
  "id",
  "jobNumber",
  "jobTypeName",
  "links",
  "milestone",
  "milestoneDetail",
  "milestoneLabel",
  "name",
  "photographer",
  "project",
  "shootDate",
  "updating",
] as const;

/**
 * `GET /api/portal/jobs` lists the client's jobs grouped by project (`PortalProjectGroup[]`).
 * Flattens that (or a plain job array, or `{ groups | items | jobs }`) into one list.
 */
export function flattenPortalJobs(data: unknown): PortalJobView[] {
  const list: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? (["groups", "items", "jobs", "projects"].map((k) => (data as Record<string, unknown>)[k]).find(Array.isArray) as unknown[] | undefined) ?? []
      : [];
  return list.flatMap((entry) => {
    if (entry && typeof entry === "object" && Array.isArray((entry as { jobs?: unknown }).jobs)) return (entry as { jobs: PortalJobView[] }).jobs;
    return [entry as PortalJobView];
  });
}

/** Comment tree node (`GET /api/jobs/:id/comments`). */
export interface CommentNodeView {
  id: string;
  parentCommentId: string | null;
  rootCommentId: string;
  author: UserRef;
  kind: string;
  body: string | null;
  replies: CommentNodeView[];
}

export const stagesOf = (entries: HistoryEntry[]): StageView[] => entries.filter((e) => e.kind === "stage" && e.stage).map((e) => e.stage as StageView);
export const eventTypesOf = (entries: HistoryEntry[]): string[] => entries.filter((e) => e.kind === "event" && e.event).map((e) => (e.event as ActivityItem).eventType);

/* ------------------------------- client -------------------------------- */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RawResult<T = unknown> {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  data: T;
  error: { code?: string; message?: string; current?: unknown; details?: unknown } | undefined;
}

type JobVerb = "accept" | "decline" | "start" | "submit" | "begin-review" | "approve" | "deliver" | "complete" | "cancel" | "reopen" | "restore" | "pause" | "resume";

/** A signed-in REST session (its own cookie jar; non-GET requests carry the Origin header). */
export class Api {
  constructor(readonly ctx: APIRequestContext) {}

  async raw<T = unknown>(method: Method, url: string, body?: unknown): Promise<RawResult<T>> {
    const send = () =>
      this.ctx.fetch(url, {
        method,
        data: body === undefined ? undefined : body,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        failOnStatusCode: false,
        maxRedirects: 0,
      });
    let res: APIResponse;
    try {
      res = await send();
    } catch (err) {
      // A pooled keep-alive socket that sat idle past the server's keep-alive
      // timeout can be reset just as it is reused (the request never reaches the
      // app). Retry once — GET only, so a retry can never repeat a mutation.
      if (method !== "GET" || !/ECONNRESET|socket hang up/.test(String(err))) throw err;
      res = await send();
    }
    let json: { data?: T; error?: RawResult["error"] } = {};
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    return { status: res.status(), ok: res.ok(), headers: res.headers(), data: json.data as T, error: json.error };
  }

  private async call<T>(method: Method, url: string, body?: unknown): Promise<T> {
    const r = await this.raw<T>(method, url, body);
    if (!r.ok) throw new ApiError(r.status, r.error?.code, `${method} ${url} → ${r.status} ${r.error?.code ?? ""}: ${r.error?.message ?? ""}`, r);
    return r.data;
  }

  get<T>(url: string) {
    return this.call<T>("GET", url);
  }
  post<T>(url: string, body: unknown = {}) {
    return this.call<T>("POST", url, body);
  }
  patch<T>(url: string, body: unknown) {
    return this.call<T>("PATCH", url, body);
  }
  put<T>(url: string, body: unknown) {
    return this.call<T>("PUT", url, body);
  }

  dispose(): Promise<void> {
    return this.ctx.dispose();
  }

  /* ---- identity ---- */
  /** Staff only (a client session gets the client-safe shape: use `clientMe`). */
  me() {
    return this.get<StaffMe>("/api/auth/me");
  }
  clientMe() {
    return this.get<ClientMe>("/api/auth/me");
  }

  /* ---- lookups (admins) ---- */
  async userByEmail(email: string): Promise<UserProfile> {
    const list = await this.get<UserProfile[]>(`/api/users?q=${encodeURIComponent(email)}`);
    const hit = list.find((u) => u.email === email);
    if (!hit) throw new Error(`user ${email} not found`);
    return hit;
  }

  private jobTypeCache = new Map<string, string>();
  async jobTypeId(name = "Real Estate"): Promise<string> {
    const cached = this.jobTypeCache.get(name);
    if (cached) return cached;
    const types = await this.get<{ id: string; name: string; archivedAt: string | null }[]>("/api/job-types");
    const hit = types.find((t) => t.name === name && !t.archivedAt);
    if (!hit) throw new Error(`job type ${name} not found`);
    this.jobTypeCache.set(name, hit.id);
    return hit.id;
  }

  async createClientAndProject(
    label = "E2E",
    contact: { contactName?: string; email?: string; phone?: string; notes?: string } = {},
  ): Promise<{ clientId: string; clientName: string; projectId: string; projectName: string }> {
    const clientName = uniq(`E2E ${label} Client`);
    const client = await this.post<{ id: string }>("/api/clients", { name: clientName, ...contact });
    const projectName = uniq(`E2E ${label} Project`);
    const project = await this.post<{ id: string }>("/api/projects", { clientId: client.id, name: projectName });
    return { clientId: client.id, clientName, projectId: project.id, projectName };
  }

  /**
   * Creates a job ("Real Estate" = the standard workflow) in a new client/project unless
   * `projectId` or `newProject` (editors: inline project under an existing `clientId`, §4.3) is given.
   * `photographerId: undefined` lets the server pick the default (admin/member: self; editor: §4.3 default).
   */
  async createJob(
    input: {
      name?: string;
      projectId?: string;
      clientId?: string;
      newProject?: { name: string; address?: string };
      jobTypeId?: string;
      photographerId?: string;
      editorId?: string | null;
      shootDate?: string;
      dueDate?: string;
      deliveryDueDate?: string;
      priority?: string;
    } = {},
  ): Promise<JobRow & { detail: JobDetail }> {
    const projectId = input.newProject ? undefined : (input.projectId ?? (await this.createClientAndProject()).projectId);
    const jobTypeId = input.jobTypeId ?? (await this.jobTypeId());
    const created = await this.post<{ job: { id: string } }>("/api/jobs", {
      name: input.name ?? uniq("E2E Job"),
      projectId,
      clientId: input.clientId,
      newProject: input.newProject,
      jobTypeId,
      photographerId: input.photographerId,
      editorId: input.editorId,
      shootDate: input.shootDate,
      dueDate: input.dueDate,
      deliveryDueDate: input.deliveryDueDate,
      priority: input.priority,
    });
    const detail = await this.job(created.job.id);
    return { ...detail.job, detail };
  }

  /** `GET /api/jobs` rows matching `q` (optionally with `?scope=`). */
  async jobsMatching(q: string, scope?: ViewScope): Promise<JobRow[]> {
    const res = await this.get<{ rows: JobRow[] }>(`/api/jobs?q=${encodeURIComponent(q)}&limit=100${scope ? `&scope=${scope}` : ""}`);
    return res.rows;
  }

  job(id: string) {
    return this.get<JobDetail>(`/api/jobs/${id}`);
  }

  /** Polls until the job reaches `category` (UI actions refresh asynchronously). */
  async waitForCategory(id: string, category: string, timeoutMs = 20_000): Promise<JobDetail> {
    let last = "";
    try {
      return await eventually(async () => {
        const d = await this.job(id);
        last = d.job.statusCategory;
        return d.job.statusCategory === category ? d : null;
      }, timeoutMs);
    } catch {
      throw new Error(`job ${id} never reached "${category}" (still "${last}")`);
    }
  }

  async version(id: string): Promise<number> {
    return (await this.job(id)).job.version;
  }

  history(id: string) {
    return this.get<HistoryEntry[]>(`/api/jobs/${id}/history`);
  }

  activity(jobId: string, limit = 200) {
    return this.get<Paginated<ActivityItem>>(`/api/jobs/${jobId}/activity?limit=${limit}`);
  }

  revisions(jobId: string) {
    return this.get<{ revisions: RevisionView[]; openRevision: RevisionView | null }>(`/api/jobs/${jobId}/revisions`);
  }

  sessions(jobId: string) {
    return this.get<{ sessions: SessionView[] }>(`/api/jobs/${jobId}/sessions`);
  }

  /* ---- workflow ---- */
  async assignEditor(jobId: string, userId: string | null, reason?: string) {
    return this.post(`/api/jobs/${jobId}/assign`, { role: "editor", userId, reason, expectedVersion: await this.version(jobId) });
  }
  /** `POST /api/jobs/:id/<verb>` with the job's current version. */
  async action(jobId: string, verb: JobVerb, extra: Record<string, unknown> = {}) {
    return this.post<{ job: JobRow }>(`/api/jobs/${jobId}/${verb}`, { expectedVersion: await this.version(jobId), ...extra });
  }
  /** accept → start → submit (as whoever this session is). */
  async driveToSubmitted(jobId: string, opts: { startTimer?: boolean } = {}) {
    await this.action(jobId, "accept");
    await this.action(jobId, "start", opts.startTimer ? { startTimer: true } : {});
    return this.action(jobId, "submit");
  }
  async requestRevision(jobId: string, reason: string, description: string) {
    return this.post<{ revision: RevisionView }>(`/api/jobs/${jobId}/revisions`, { expectedVersion: await this.version(jobId), reason, description });
  }
  async resolveRevision(jobId: string, note?: string) {
    const detail = await this.job(jobId);
    if (!detail.openRevision) throw new Error("no open revision");
    return this.post<{ job: JobRow }>(`/api/revisions/${detail.openRevision.id}/resolve`, { expectedVersion: detail.job.version, note });
  }
  async reopen(jobId: string, reason: string, toCategory?: "in_progress" | "revision" | "approved") {
    return this.action(jobId, "reopen", { reason, toCategory });
  }
  async addLink(jobId: string, kind: string, url: string, label?: string) {
    return this.post<{ id: string; url: string }>(`/api/jobs/${jobId}/links`, { kind, url, label });
  }
  /**
   * `POST /api/jobs/:id/transition { toCategory }` — the generic move (kanban, Deliver dialog).
   * `delivery` is the §7.3 Deliver-dialog payload, allowed only on a delivering move.
   */
  async transition(jobId: string, toCategory: string, extra: { reason?: string; delivery?: { shareJob?: boolean; shareLinkIds?: string[] } } = {}) {
    return this.post<{ job: JobRow }>(`/api/jobs/${jobId}/transition`, { toCategory, expectedVersion: await this.version(jobId), ...extra });
  }
  rawTransition(jobId: string, toCategory: string, expectedVersion: number, extra: Record<string, unknown> = {}) {
    return this.raw("POST", `/api/jobs/${jobId}/transition`, { toCategory, expectedVersion, ...extra });
  }

  /* ---- notes & comments ---- */
  addNote(jobId: string, kind: string, body: string) {
    return this.post<{ id: string }>(`/api/jobs/${jobId}/notes`, { kind, body });
  }
  notes(jobId: string) {
    return this.get<{ id: string; kind: string; body: string; archivedAt: string | null }[]>(`/api/jobs/${jobId}/notes`);
  }
  addComment(jobId: string, body: string, extra: { kind?: string; parentCommentId?: string; mentionUserIds?: string[] } = {}) {
    return this.post<{ id: string }>(`/api/jobs/${jobId}/comments`, { body, mentionUserIds: [], ...extra });
  }
  comments(jobId: string) {
    return this.get<CommentNodeView[]>(`/api/jobs/${jobId}/comments`);
  }

  /* ---- client sharing (docs/ROLES.md §7.1–§7.3; staff) ---- */
  async clientVersion(clientId: string): Promise<number> {
    return (await this.get<{ client: { version: number } }>(`/api/clients/${clientId}`)).client.version;
  }
  async projectVersion(projectId: string): Promise<number> {
    return (await this.get<{ project: { version: number } }>(`/api/projects/${projectId}`)).project.version;
  }
  /** `POST /api/clients/:id/portal` (admin). */
  async setClientPortal(clientId: string, flags: { portalEnabled?: boolean; feedbackEnabled?: boolean }) {
    return this.post(`/api/clients/${clientId}/portal`, { ...flags, expectedVersion: await this.clientVersion(clientId) });
  }
  /** `POST /api/jobs/:id/share` (`job.share_with_client`). */
  async shareJob(jobId: string, shared = true) {
    return this.post(`/api/jobs/${jobId}/share`, { shared, expectedVersion: await this.version(jobId) });
  }
  /** `POST /api/projects/:id/share` (admin). */
  async shareProject(projectId: string, shared = true) {
    return this.post(`/api/projects/${projectId}/share`, { shared, expectedVersion: await this.projectVersion(projectId) });
  }
  /** `POST /api/links/:id/share` (current links only). */
  shareLink(linkId: string, shared = true) {
    return this.post(`/api/links/${linkId}/share`, { shared });
  }

  /* ---- client portal (docs/ROLES.md §7.7; client sessions) ---- */
  async portalJobs(): Promise<PortalJobView[]> {
    return flattenPortalJobs(await this.get<unknown>("/api/portal/jobs"));
  }
  portalJob(jobId: string) {
    return this.get<PortalJobDetailView>(`/api/portal/jobs/${jobId}`);
  }
  postFeedback(jobId: string, body: string, parentCommentId?: string) {
    return this.post<{ id: string }>(`/api/portal/jobs/${jobId}/feedback`, { body, parentCommentId });
  }
  portalNotifications() {
    return this.get<Paginated<NotificationView>>("/api/portal/notifications");
  }

  /* ---- view scope (docs/ROLES.md §8) ---- */
  /** `POST /api/me/scope` sets the `pwm_scope` cookie on THIS session's cookie jar. Use a disposable session. */
  setScope(scope: ViewScope) {
    return this.post("/api/me/scope", { scope });
  }

  /* ---- people ---- */
  /**
   * Invites a user (admins). Photographers are team members unless `isAdmin`; flags left out take
   * the invite defaults (§2.2: create ✓, assign ✓, review ✗, the rest ✗; editors create ✓, team ✗).
   * Client users need `clientId` of a client with the portal on.
   */
  async inviteUser(role: "photographer" | "editor" | "client", labelOrOptions: string | InviteOptions = "E2E"): Promise<InvitedUser> {
    const opts: InviteOptions = typeof labelOrOptions === "string" ? { label: labelOrOptions } : labelOrOptions;
    const label = opts.label ?? "E2E";
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `e2e-${role}-${stamp}@studio.test`;
    const res = await this.post<{ user: UserProfile; tempPassword: string }>("/api/users", {
      email,
      name: `E2E ${label} ${role} ${stamp}`,
      role,
      title: opts.title,
      isAdmin: opts.isAdmin,
      flags: opts.flags,
      clientId: opts.clientId,
    });
    return { ...res, email };
  }
  async userVersion(userId: string): Promise<number> {
    const detail = await this.get<{ profile: { version: number } | null }>(`/api/users/${userId}`);
    if (!detail.profile) throw new Error(`no full profile for ${userId} (not an admin session?)`);
    return detail.profile.version;
  }
  /** `POST /api/users/:id/permissions` (admin; member or editor switches). */
  async setPermissions(userId: string, flags: Partial<PermissionFlags>) {
    return this.post(`/api/users/${userId}/permissions`, { ...flags, expectedVersion: await this.userVersion(userId) });
  }
  /** `POST /api/users/:id/admin` (admin; never self). */
  async setAdmin(userId: string, isAdmin: boolean) {
    return this.post(`/api/users/${userId}/admin`, { isAdmin, expectedVersion: await this.userVersion(userId) });
  }
  async deactivateUser(userId: string, reason = "E2E cleanup", reassignTo?: string) {
    return this.post(`/api/users/${userId}/deactivate`, { expectedVersion: await this.userVersion(userId), reason, reassignTo });
  }

  /* ---- notifications ---- */
  notifications(unreadOnly = false) {
    return this.get<Paginated<NotificationView>>(`/api/notifications?limit=200${unreadOnly ? "&unread=1" : ""}`);
  }
}

/**
 * No cookies. Inside a test, `request.newContext()` inherits the test's `use`
 * options — including the role fixture's signed-in `storageState` — so an
 * anonymous or fresh-login context must say so explicitly.
 */
export const NO_SESSION = { cookies: [], origins: [] };

/** A new request context bound to the server; with `storageState` it acts as that user, without it as nobody. */
export async function newApi(storageState?: string): Promise<Api> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: storageState ?? NO_SESSION, extraHTTPHeaders: { Origin: BASE_URL } });
  return new Api(ctx);
}

/** Signs in through `POST /api/auth/login` (no UI) and returns the authenticated client. */
export async function loginApi(email: string, password = DEMO_PASSWORD): Promise<Api> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: NO_SESSION, extraHTTPHeaders: { Origin: BASE_URL } });
  const res = await ctx.post("/api/auth/login", { data: { email, password } });
  if (!res.ok()) {
    const body = await res.text();
    await ctx.dispose();
    throw new Error(`login ${email} failed: ${res.status()} ${body}`);
  }
  return new Api(ctx);
}
