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

export type Role = "owner" | "manager" | "photographer" | "photographer-noflags" | "editor" | "editor-overloaded" | "other-owner";

/** Seeded demo accounts (src/db/seed/catalog.ts). Password for all: Password123!. */
export const ROLE_EMAILS: Record<Role, string> = {
  owner: "owner@studio.test",
  manager: "manager1@studio.test",
  photographer: "photographer01@studio.test",
  "photographer-noflags": "photographer02@studio.test",
  editor: "editor01@studio.test",
  "editor-overloaded": "editor03@studio.test",
  "other-owner": "owner@other.test",
};

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
  me() {
    return this.get<{ user: { id: string; name: string; role: string; email: string }; unreadCount: number }>("/api/auth/me");
  }

  /* ---- lookups (owner/manager) ---- */
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

  async createClientAndProject(label = "E2E"): Promise<{ clientId: string; clientName: string; projectId: string; projectName: string }> {
    const clientName = uniq(`E2E ${label} Client`);
    const client = await this.post<{ id: string }>("/api/clients", { name: clientName });
    const projectName = uniq(`E2E ${label} Project`);
    const project = await this.post<{ id: string }>("/api/projects", { clientId: client.id, name: projectName });
    return { clientId: client.id, clientName, projectId: project.id, projectName };
  }

  /** Creates a job ("Real Estate" = the standard workflow) in a new client/project unless one is given. */
  async createJob(
    input: { name?: string; projectId?: string; jobTypeId?: string; photographerId?: string; editorId?: string; dueDate?: string; priority?: string } = {},
  ): Promise<JobRow & { detail: JobDetail }> {
    const projectId = input.projectId ?? (await this.createClientAndProject()).projectId;
    const jobTypeId = input.jobTypeId ?? (await this.jobTypeId());
    const created = await this.post<{ job: { id: string } }>("/api/jobs", {
      name: input.name ?? uniq("E2E Job"),
      projectId,
      jobTypeId,
      photographerId: input.photographerId,
      editorId: input.editorId,
      dueDate: input.dueDate,
      priority: input.priority,
    });
    const detail = await this.job(created.job.id);
    return { ...detail.job, detail };
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

  /* ---- people ---- */
  async inviteUser(role: "photographer" | "editor" | "manager", label = "E2E"): Promise<InvitedUser> {
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `e2e-${role}-${stamp}@studio.test`;
    const res = await this.post<{ user: UserProfile; tempPassword: string }>("/api/users", { email, name: `E2E ${label} ${role} ${stamp}`, role });
    return { ...res, email };
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
