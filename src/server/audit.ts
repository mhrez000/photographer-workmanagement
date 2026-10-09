/**
 * The ONLY insert path into `activity_events` (ARCHITECTURE.md §5).
 *
 * - runs inside the caller's transaction (`tx`), so a mutation and its
 *   evidence commit or roll back together
 * - computes the frozen, actor-less `summary` (src/lib/audit-summaries.ts)
 * - forces `visibility = "management"` for MANAGEMENT_EVENT_PREFIXES and for
 *   note events on internal notes
 * - always writes `metadata = { requestId, cause, …extras }`
 * - `redact()`s every snapshot (no password hashes, secrets or tokens)
 * - bumps `jobs.last_activity_at` (monotonic MAX, no version bump) when the
 *   event belongs to a job
 * - enqueues matching automation rules (`enqueueAutomations`, §7) in the same
 *   transaction — the single automation hook; runs execute after commit
 *
 * There is deliberately no update/delete helper here or anywhere else; the
 * DB triggers (src/db/guard.ts) reject both.
 */
import { and, eq, sql } from "drizzle-orm";
import { activityEvents, jobs, type Json } from "@/db/schema";
import type { Tx } from "@/db/index";
import {
  EVENT_TYPES,
  MANAGEMENT_EVENT_PREFIXES,
  type EntityType,
  type EventAction,
  type EventCause,
  type EventType,
  type EventVisibility,
} from "@/lib/constants";
import { summarise } from "@/lib/audit-summaries";
import { newId } from "@/lib/ids";
import type { AuthContext } from "@/lib/types";
import { enqueueAutomations } from "@/server/services/automationTriggers";

export interface RecordEventInput {
  entityType: EntityType;
  entityId: string;
  /** Set for every event about a job (or a job's ledger rows). */
  jobId?: string | null;
  eventType: EventType;
  action: EventAction;
  previousValue?: unknown;
  newValue?: unknown;
  /** Extras merged after `{ requestId, cause }` (e.g. transitionId, reason, onBehalfOf, batchId). */
  metadata?: Record<string, unknown>;
  /** Requested visibility; may be upgraded to "management", never downgraded. */
  visibility?: EventVisibility;
}

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);
const SENSITIVE_KEY = /password|secret|token/i;

/**
 * Deep-copies a value into plain JSON, dropping `passwordHash` and every key
 * matching /password|secret|token/i. Dates become ISO strings, `undefined`
 * and functions are dropped, non-finite numbers become null.
 */
export function redact(value: unknown): Json {
  return redactInner(value, 0);
}

function redactInner(value: unknown, depth: number): Json {
  if (depth > 20) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : redactInner(v, depth + 1)));
  if (value instanceof Set) return Array.from(value, (v) => redactInner(v, depth + 1));
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || typeof v === "function") continue;
      if (key === "passwordHash" || SENSITIVE_KEY.test(key)) continue;
      out[key] = redactInner(v, depth + 1);
    }
    return out;
  }
  return null;
}

/** True when this event must be hidden from photographers/editors. */
export function isManagementEvent(eventType: string, previousValue: unknown, newValue: unknown, metadata: unknown): boolean {
  if (MANAGEMENT_EVENT_PREFIXES.some((prefix) => eventType.startsWith(prefix))) return true;
  if (eventType.startsWith("note.")) {
    for (const v of [newValue, previousValue, metadata]) {
      if (v && typeof v === "object") {
        const bag = v as Record<string, unknown>;
        if (bag.kind === "internal" || bag.noteKind === "internal") return true;
      }
    }
  }
  return false;
}

function defaultCause(ctx: AuthContext): EventCause {
  if (ctx.cause) return ctx.cause;
  if (ctx.automationRunId) return "automation";
  return ctx.isSystem ? "sweep" : "user";
}

/**
 * Appends one audit event inside `tx` and returns its id.
 * Throws on an unknown event type (programming error → the whole mutation rolls back).
 */
export function recordEvent(tx: Tx, ctx: AuthContext, input: RecordEventInput): string {
  if (!EVENT_TYPE_SET.has(input.eventType)) {
    throw new Error(`recordEvent: unknown event type "${input.eventType}"`);
  }
  const createdAt = ctx.now();
  const extra = input.metadata ?? {};
  const automationRunIdRaw = extra.automationRunId ?? ctx.automationRunId ?? null;
  const automationRunId = typeof automationRunIdRaw === "string" ? automationRunIdRaw : null;

  const metadataJson = redact({
    ...extra,
    requestId: typeof extra.requestId === "string" ? extra.requestId : ctx.requestId,
    cause: typeof extra.cause === "string" ? extra.cause : defaultCause(ctx),
    ...(automationRunId ? { automationRunId } : {}),
  });
  const metadata = (metadataJson && typeof metadataJson === "object" && !Array.isArray(metadataJson) ? metadataJson : {}) as Record<
    string,
    Json
  >;
  const previousValue = input.previousValue === undefined ? null : redact(input.previousValue);
  const newValue = input.newValue === undefined ? null : redact(input.newValue);

  const visibility: EventVisibility =
    input.visibility === "management" || isManagementEvent(input.eventType, previousValue, newValue, metadata) ? "management" : "all";

  const summary = summarise(input.eventType, previousValue, newValue, metadata, { timeZone: ctx.settings.timezone });

  const id = newId();
  tx.insert(activityEvents)
    .values({
      id,
      organisationId: ctx.organisationId,
      actorUserId: ctx.userId,
      automationRunId,
      jobId: input.jobId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      eventType: input.eventType,
      action: input.action,
      previousValue,
      newValue,
      metadata,
      summary,
      visibility,
      createdAt,
    })
    .run();

  if (input.jobId) {
    // MAX semantics so a backdated event (seed under a moving clock) never rewinds it.
    tx.update(jobs)
      .set({ lastActivityAt: sql`CASE WHEN ${jobs.lastActivityAt} < ${createdAt} THEN ${createdAt} ELSE ${jobs.lastActivityAt} END` })
      .where(and(eq(jobs.id, input.jobId), eq(jobs.organisationId, ctx.organisationId)))
      .run();
  }

  // Automation hook (§7): pending runs for matching rules, inside this tx.
  enqueueAutomations(tx, ctx, {
    eventId: id,
    eventType: input.eventType,
    jobId: input.jobId ?? null,
    previousValue,
    newValue,
    automationRunId,
  });
  return id;
}

/** Records several events in order (same tx); returns their ids. */
export function recordEvents(tx: Tx, ctx: AuthContext, inputs: readonly RecordEventInput[]): string[] {
  return inputs.map((input) => recordEvent(tx, ctx, input));
}
