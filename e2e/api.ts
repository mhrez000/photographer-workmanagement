/**
 * The e2e helper module: server URL, the SMALL demo roster, a thin REST client
 * and data factories (src/app/api/README.md is the contract).
 *
 * Every spec builds the data it needs through these helpers with unique names
 * and asserts on those entities only, so specs never depend on seeded counts,
 * on each other, or on other people using the same dev database. Seeded demo
 * accounts are only ever signed in through their own cookie jars — never
 * logged out, deactivated or archived (logout / deactivation tests use users
 * the spec invites).
 *
 * Setup goes through the PERMANENT engine routes (assign, start, submit,
 * revisions, approve / deliver / complete, cancel, restore): the simplified
 * one-button steps are a display layer over the same statuses (plan §4, §9), so
 * a job driven here looks exactly like one driven through the new buttons. The
 * buttons themselves are exercised through the UI by the specs.
 */
import path from "node:path";
import { expect, request as playwrightRequest, type APIRequestContext, type APIResponse } from "@playwright/test";

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
 * The SMALL demo roster (docs/SIMPLIFICATION-PLAN.md §8; src/db/seed/small.ts):
 * one owner who also shoots, one extra photographer ("Only their own shoots"),
 * three editors, one portal client, and the other studio for isolation tests.
 */
export type Role =
  /** Mo Carter — Owner / Photographer: admin and primary owner; also shoots. */
  | "owner"
  /** Priya Nair — extra photographer, "Only their own shoots" preset. */
  | "photographer"
  /** Sam Whitfield — editor (usually handles up to 6). */
  | "editor"
  /** Ava Mitchell — editor. */
  | "editor2"
  /** Lucas Pham — editor (usually handles up to 4). */
  | "editor3"
  /** Sarah Kingsley — Harbourline Realty's portal user (portal + feedback on). */
  | "client"
  /** Admin of the second organisation (tenant isolation). */
  | "other-owner"
  /** Client portal user of the second organisation. */
  | "other-client";

/** Seeded demo accounts. Password for all: Password123!. */
export const ROLE_EMAILS: Record<Role, string> = {
  owner: "owner@studio.test",
  photographer: "photographer01@studio.test",
  editor: "editor01@studio.test",
  editor2: "editor02@studio.test",
  editor3: "editor03@studio.test",
  client: "client@studio.test",
  "other-owner": "owner@other.test",
  "other-client": "client@other.test",
};

/** Seeded display names (small.ts) — the plan's "Waiting on: Sam" is Sam Whitfield. */
export const ROLE_NAMES: Partial<Record<Role, string>> = {
  owner: "Mo Carter",
  photographer: "Priya Nair",
  editor: "Sam Whitfield",
  editor2: "Ava Mitchell",
  editor3: "Lucas Pham",
  client: "Sarah Kingsley",
};

/** Seeded clients of the small demo. Harbourline uses the portal; Coastal Key does not. */
export const SEED_CLIENTS = { portal: "Harbourline Realty", noPortal: "Coastal Key Property" } as const;

/** Accounts that use the client portal (never the staff shell). */
export const CLIENT_ROLES: readonly Role[] = ["client", "other-client"];
export const isClientRole = (role: Role): boolean => CLIENT_ROLES.includes(role);

/** Where each persona lands after sign-in (plan §3; src/server/page.ts homePathFor). */
export const HOME_PATH = { photographer: "/home", editor: "/my-jobs", client: "/portal" } as const;

/** The pages of the simplified product (everything a hidden page may redirect to). */
export const SIMPLE_PAGE_RE = /^\/(home|jobs|editors|clients|my-jobs|calendar|settings\/(studio|people|shoot-types|account|history))(\/[^?]*)?(\?.*)?$/;

/**
 * "Hidden pages are also blocked on the server" (plan §3, §8): while Advanced tools is off a hidden
 * page is a 404, or a 307 to its simple replacement — never a 200 of its own.
 */
export function expectHiddenPage(res: { status: number; location: string | null }, path: string): void {
  if (res.status === 307) {
    const target = new URL(res.location ?? "", "http://x").pathname + new URL(res.location ?? "", "http://x").search;
    expect(target, `${path} redirects to a simple page`).toMatch(SIMPLE_PAGE_RE);
    return;
  }
  expect(res.status, `${path} is blocked (404 or a redirect), got ${res.status}`).toBe(404);
}

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

/** Unique, human-readable name so entities never collide between runs. */
export function uniq(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** A unique https URL (any link counts as a finished link, plan §5). */
export function uniqUrl(slug: string): string {
  return `https://drive.google.com/drive/folders/e2e-${slug}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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
  shootDate: string | null;
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
  job: JobRow & { createdBy: UserRef; completedAt: string | null; reopenedCount: number; sharedWithClient?: boolean };
  revisions: RevisionView[];
  openRevision: RevisionView | null;
  actions: Record<string, unknown> & {
    transitions: { toStatus: StatusRef; label: string; isReopen?: boolean }[];
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
/** `Api.inviteUser` options (`POST /api/users`). Omitted flags take the invite defaults. */
export interface InviteOptions {
  label?: string;
  title?: string;
  /** Photographers only (plan §2): the one invite choice. */
  preset?: "own_shoots" | "co_owner";
  /** Photographers only: "Make admin (co-owner)". */
  isAdmin?: boolean;
  flags?: Partial<PermissionFlags>;
  /** Required for `role: "client"`: a portal-enabled client of the organisation. */
  clientId?: string;
}

/** `GET /api/auth/me` for staff. */
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
  settings?: { version: number; advancedToolsEnabled?: boolean; timezone: string };
  unreadCount: number;
}
/** `GET /api/auth/me` for a client portal user (client-safe shape). */
export interface ClientMe {
  kind: "client";
  name: string;
  email: string;
  clientName: string;
  studioName: string;
  unreadCount: number;
}

/** `GET /api/settings` (admins). */
export interface SettingsView {
  organisation: { id: string; name: string; slug: string };
  settings: { version: number; advancedToolsEnabled?: boolean; timezone: string; organisationName?: string };
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

/** `GET /api/jobs/:id/links` slot. */
export interface LinkSlotView {
  kind: string;
  current: { id: string; url: string; label: string | null; addedBy: UserRef } | null;
  history: { id: string; url: string; supersededAt?: string | null }[];
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

type JobVerb = "accept" | "decline" | "start" | "submit" | "begin-review" | "approve" | "deliver" | "complete" | "cancel" | "reopen" | "restore";

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

  /** Status code of a page GET (no redirects followed). */
  async pageStatus(pathname: string): Promise<{ status: number; location: string | null }> {
    const res = await this.ctx.get(pathname, { maxRedirects: 0, failOnStatusCode: false });
    return { status: res.status(), location: res.headers().location ?? null };
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

  /** A seeded client by name (admins see every client). */
  async clientByName(name: string): Promise<{ id: string; name: string }> {
    const list = await this.get<{ id: string; name: string }[]>(`/api/clients?q=${encodeURIComponent(name)}`);
    const hit = list.find((c) => c.name === name);
    if (!hit) throw new Error(`client ${name} not found`);
    return hit;
  }

  /** A fresh client (optionally with the portal on). */
  async createClient(label = "E2E", opts: { portal?: boolean; feedback?: boolean; contact?: { contactName?: string; email?: string; phone?: string; notes?: string } } = {}) {
    const clientName = uniq(`E2E ${label} Client`);
    const client = await this.post<{ id: string }>("/api/clients", { name: clientName, ...(opts.contact ?? {}) });
    if (opts.portal) await this.setClientPortal(client.id, { portalEnabled: true, feedbackEnabled: opts.feedback ?? true });
    return { clientId: client.id, clientName };
  }

  async createClientAndProject(
    label = "E2E",
    contact: { contactName?: string; email?: string; phone?: string; notes?: string } = {},
  ): Promise<{ clientId: string; clientName: string; projectId: string; projectName: string }> {
    const { clientId, clientName } = await this.createClient(label, { contact });
    const projectName = uniq(`E2E ${label} Project`);
    const project = await this.post<{ id: string }>("/api/projects", { clientId, name: projectName });
    return { clientId, clientName, projectId: project.id, projectName };
  }

  /**
   * Creates a job ("Real Estate" = the standard workflow). Without `projectId` / `newProject` /
   * `autoProject` a fresh client is created and the project is derived from the address
   * (plan §5 "silent projects"). `photographerId: undefined` lets the server pick the default.
   */
  async createJob(
    input: {
      name?: string;
      /** The address / job name typed on the New job form (defaults to `name`). */
      address?: string;
      projectId?: string;
      clientId?: string;
      newProject?: { name: string; address?: string };
      autoProject?: { clientId: string; address: string };
      jobTypeId?: string;
      photographerId?: string;
      editorId?: string | null;
      shootDate?: string;
      dueDate?: string | null;
      deliveryDueDate?: string;
      priority?: string;
      description?: string;
    } = {},
  ): Promise<JobRow & { detail: JobDetail }> {
    const name = input.name ?? uniq("E2E Job");
    let projectTarget: Record<string, unknown>;
    if (input.projectId) projectTarget = { projectId: input.projectId };
    else if (input.newProject) projectTarget = { clientId: input.clientId, newProject: input.newProject };
    else if (input.autoProject) projectTarget = { autoProject: input.autoProject };
    else {
      const clientId = input.clientId ?? (await this.createClient()).clientId;
      projectTarget = { autoProject: { clientId, address: input.address ?? name } };
    }
    const jobTypeId = input.jobTypeId ?? (await this.jobTypeId());
    const created = await this.post<{ job: { id: string } }>("/api/jobs", {
      name,
      ...projectTarget,
      jobTypeId,
      photographerId: input.photographerId,
      editorId: input.editorId,
      shootDate: input.shootDate,
      dueDate: input.dueDate,
      deliveryDueDate: input.deliveryDueDate,
      priority: input.priority,
      description: input.description,
    });
    const detail = await this.job(created.job.id);
    return { ...detail.job, detail };
  }

  /** `GET /api/jobs` rows matching `q`. */
  async jobsMatching(q: string): Promise<JobRow[]> {
    const res = await this.get<{ rows: JobRow[] }>(`/api/jobs?q=${encodeURIComponent(q)}&limit=100`);
    return res.rows;
  }

  job(id: string) {
    return this.get<JobDetail>(`/api/jobs/${id}`);
  }

  /** Polls until the job reaches one of `categories` (UI actions refresh asynchronously). */
  async waitForCategory(id: string, category: string | readonly string[], timeoutMs = 20_000): Promise<JobDetail> {
    const wanted = typeof category === "string" ? [category] : [...category];
    let last = "";
    try {
      return await eventually(async () => {
        const d = await this.job(id);
        last = d.job.statusCategory;
        return wanted.includes(d.job.statusCategory) ? d : null;
      }, timeoutMs);
    } catch {
      throw new Error(`job ${id} never reached "${wanted.join(" | ")}" (still "${last}")`);
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

  links(jobId: string, history = false) {
    return this.get<LinkSlotView[]>(`/api/jobs/${jobId}/links${history ? "?history=1" : ""}`);
  }

  /* ---- workflow (engine routes; permanent) ---- */
  async assignEditor(jobId: string, userId: string | null, reason?: string) {
    return this.post(`/api/jobs/${jobId}/assign`, { role: "editor", userId, reason, expectedVersion: await this.version(jobId) });
  }
  /** `POST /api/jobs/:id/<verb>` with the job's current version. */
  async action(jobId: string, verb: JobVerb, extra: Record<string, unknown> = {}) {
    return this.post<{ job: JobRow }>(`/api/jobs/${jobId}/${verb}`, { expectedVersion: await this.version(jobId), ...extra });
  }
  /** Start editing (as the assigned editor, or the owner on their behalf). */
  async startEditing(jobId: string) {
    const d = await this.job(jobId);
    if (d.job.statusCategory === "in_progress") return d;
    await this.action(jobId, "start");
    return this.job(jobId);
  }
  /**
   * The editor's "Send for checking" (plan §5): records a finished link, starts editing when the job had
   * not started, then submits (or resolves the open round → Resubmitted). As whoever this session is.
   */
  /**
   * Send for checking (`POST /api/jobs/:id/simple/send-for-checking`, plan §5): records the finished
   * link (a new address becomes the current version of the one Finished photos slot) and moves the job
   * to Ready to check — starting the editing step first if needed, or closing the open round of changes.
   */
  async sendForChecking(jobId: string, url = uniqUrl("finished"), note?: string): Promise<JobDetail> {
    await this.post(`/api/jobs/${jobId}/simple/send-for-checking`, {
      expectedVersion: await this.version(jobId),
      finishedLink: { url, label: "Finished photos" },
      ...(note ? { note } : {}),
    });
    return this.job(jobId);
  }
  /** Ask for changes (plan §5): one note, optional chips as the reason, needed back by (default tomorrow). */
  async askForChanges(jobId: string, note: string, chips: string[] = [], neededBy = civilDate(1)) {
    return this.post<{ revision: RevisionView; job: JobRow }>(`/api/jobs/${jobId}/revisions`, {
      expectedVersion: await this.version(jobId),
      reason: chips.length ? chips.join(", ") : "Changes",
      description: note,
      dueDate: neededBy,
    });
  }
  async requestRevision(jobId: string, reason: string, description: string) {
    return this.post<{ revision: RevisionView }>(`/api/jobs/${jobId}/revisions`, { expectedVersion: await this.version(jobId), reason, description });
  }
  async resolveRevision(jobId: string, note?: string) {
    const detail = await this.job(jobId);
    if (!detail.openRevision) throw new Error("no open revision");
    return this.post<{ job: JobRow }>(`/api/revisions/${detail.openRevision.id}/resolve`, { expectedVersion: detail.job.version, note });
  }
  /**
   * Approve (plan §5, decision 2) through the recorded engine steps: "send" = Approved → Delivered (shares
   * the job) → Completed; "only" = Approved; "n/a" = Approved → Completed.
   */
  /**
   * The one Approve (`POST /api/jobs/:id/simple/approve`, plan §5): "send" = Approve & send (Approved →
   * Delivered → Completed, sharing the finished links with the client), "only" = Approve only, "n/a" =
   * the client has no portal (Approved → Completed). `extra` may carry `confirmSelfApproval`.
   */
  async approve(jobId: string, share: "send" | "only" | "n/a" = "n/a", extra: Record<string, unknown> = {}) {
    await this.post(`/api/jobs/${jobId}/simple/approve`, { expectedVersion: await this.version(jobId), share, ...extra });
    return this.job(jobId);
  }
  /**
   * "Send to client" on a Done · Not sent to client job (plan §5): the recorded delivery step, sharing the
   * job and its current finished links — the same request the Send to client dialog makes.
   */
  async sendToClient(jobId: string) {
    const shareLinkIds = (await this.links(jobId)).filter((s) => ["finished_files", "gallery", "download"].includes(s.kind) && s.current).map((s) => s.current!.id);
    return this.transition(jobId, "delivered", { delivery: { shareJob: true, ...(shareLinkIds.length ? { shareLinkIds } : {}) } });
  }
  async reopen(jobId: string, reason: string, toCategory?: "in_progress" | "revision" | "approved") {
    return this.action(jobId, "reopen", { reason, toCategory });
  }
  async addLink(jobId: string, kind: string, url: string, label?: string) {
    return this.post<{ id: string; url: string }>(`/api/jobs/${jobId}/links`, { kind, url, label });
  }
  /** `POST /api/links/:id/replace { url }` — a new version of the same slot (the old row is kept as history). */
  replaceLink(linkId: string, url: string, label?: string) {
    return this.post<{ link: { id: string; url: string }; previous: { id: string } }>(`/api/links/${linkId}/replace`, label === undefined ? { url } : { url, label });
  }
  /**
   * `POST /api/jobs/:id/transition { toCategory }` — the generic move.
   * `delivery` is the Deliver payload, allowed only on a delivering move.
   */
  async transition(jobId: string, toCategory: string, extra: Record<string, unknown> = {}) {
    return this.post<{ job: JobRow }>(`/api/jobs/${jobId}/transition`, { toCategory, expectedVersion: await this.version(jobId), ...extra });
  }
  rawTransition(jobId: string, toCategory: string, expectedVersion: number, extra: Record<string, unknown> = {}) {
    return this.raw("POST", `/api/jobs/${jobId}/transition`, { toCategory, expectedVersion, ...extra });
  }

  /* ---- notes & messages ---- */
  addNote(jobId: string, kind: string, body: string) {
    return this.post<{ id: string }>(`/api/jobs/${jobId}/notes`, { kind, body });
  }
  notes(jobId: string) {
    return this.get<{ id: string; kind: string; body: string; archivedAt: string | null }[]>(`/api/jobs/${jobId}/notes`);
  }
  /** `POST /api/jobs/:id/comments` → the new comment (the route answers `{ comment, mentionUserIds, … }`). */
  async addComment(jobId: string, body: string, extra: { kind?: string; parentCommentId?: string; mentionUserIds?: string[] } = {}) {
    const res = await this.post<{ comment: { id: string; body: string; kind: string; parentCommentId: string | null } }>(`/api/jobs/${jobId}/comments`, { body, mentionUserIds: [], ...extra });
    return res.comment;
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
  /** `POST /api/jobs/:id/share`. */
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

  /* ---- client portal (client sessions) ---- */
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

  /* ---- people ---- */
  /**
   * Invites a user (admins). Photographers take the invite `preset` (plan §2) or explicit switches;
   * editors cannot add jobs unless `flags.canCreateJobs`. Client users need `clientId` of a client with
   * the portal on.
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
      preset: opts.preset,
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
  /** `POST /api/users/:id/usual-capacity { usualCapacityJobs | null }` — "Usually handles up to N" (plan §7). */
  async setUsualCapacity(userId: string, usualCapacityJobs: number | null) {
    return this.post(`/api/users/${userId}/usual-capacity`, { usualCapacityJobs, expectedVersion: await this.userVersion(userId) });
  }
  async setPermissions(userId: string, flags: Partial<PermissionFlags>) {
    return this.post(`/api/users/${userId}/permissions`, { ...flags, expectedVersion: await this.userVersion(userId) });
  }
  /** `POST /api/users/:id/admin` (admin; never self). */
  async setAdmin(userId: string, isAdmin: boolean) {
    return this.post(`/api/users/${userId}/admin`, { isAdmin, expectedVersion: await this.userVersion(userId) });
  }
  /** `POST /api/users/:id/role` (admin; photographer ⇄ editor). */
  async setRole(userId: string, role: "photographer" | "editor") {
    return this.post(`/api/users/${userId}/role`, { role, expectedVersion: await this.userVersion(userId) });
  }
  async deactivateUser(userId: string, reason = "E2E cleanup", reassignTo?: string) {
    return this.post(`/api/users/${userId}/deactivate`, { expectedVersion: await this.userVersion(userId), reason, reassignTo });
  }

  /* ---- notifications ---- */
  notifications(unreadOnly = false) {
    return this.get<Paginated<NotificationView>>(`/api/notifications?limit=200${unreadOnly ? "&unread=1" : ""}`);
  }
  /** `PUT /api/users/:id/notification-prefs` (self). */
  setNotificationPrefs(userId: string, prefs: Record<string, boolean>) {
    return this.put(`/api/users/${userId}/notification-prefs`, { prefs });
  }

  /* ---- studio settings (admins) ---- */
  settings() {
    return this.get<SettingsView>("/api/settings");
  }
  /** Settings → Studio → Advanced tools (plan §8): idempotent; returns whether the switch changed. */
  async setAdvancedTools(enabled: boolean): Promise<boolean> {
    const current = await this.settings();
    if ((current.settings.advancedToolsEnabled ?? false) === enabled) return false;
    await this.patch("/api/settings", { expectedVersion: current.settings.version, advancedToolsEnabled: enabled });
    return true;
  }
  async advancedToolsOn(): Promise<boolean> {
    return (await this.settings()).settings.advancedToolsEnabled ?? false;
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
