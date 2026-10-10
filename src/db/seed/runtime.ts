/**
 * Seed runtime: a movable clock, a global time-ordered step queue and the
 * `act()` helper that runs one service call as a real user, in one
 * transaction, followed by the organisation's pending automation runs
 * (exactly what `withTxThenAutomations` does for route handlers).
 *
 * Every step of every job is scheduled up front with an absolute timestamp;
 * `runQueue()` executes them in global time order with the clock set to the
 * step's instant. That keeps history consistent across jobs (users are
 * deactivated at the right moment, one running timer per user, automations
 * and sweeps see the world as it was) and guarantees no ledger row is ever
 * dated before its predecessor.
 *
 * Everything is async (Postgres): steps are awaited strictly one after
 * another, so the PRNG is consumed in the same order on every run.
 */
import type { Db } from "@/db/index";
import { rootErrorMessage } from "@/db/errors";
import type { AuthContext } from "@/lib/types";
import { AppError } from "@/server/errors";
import { setClock } from "@/server/clock";
import { buildContextFromDb } from "@/server/auth/session";
import { withTx, type Tx } from "@/server/services/_shared";
import { runPendingAutomations } from "@/server/services/automationEngine";
import { Rng } from "./prng";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

interface QueuedStep {
  at: number;
  seq: number;
  label: string;
  run: () => Promise<void> | void;
}

export class SeedRuntime {
  readonly rng = new Rng(42);
  /** `"<org slug>:<user key>"` → user id. */
  readonly userIds = new Map<string, string>();
  /** user id → organisation id. */
  readonly userOrg = new Map<string, string>();
  readonly skipped: string[] = [];
  /** Wall-clock cost per step kind (for tuning the seed's speed). */
  readonly timings = new Map<string, { n: number; ms: number }>();
  stepsRun = 0;

  private readonly queue: QueuedStep[] = [];
  private seq = 0;
  private requestSeq = 0;

  constructor(
    readonly db: Db,
    /** The real "now" the history is generated up to (ms). */
    readonly nowMs: number,
    readonly log: (line: string) => void = () => {},
  ) {}

  /* ----------------------------- clock ----------------------------- */

  setTime(ms: number): void {
    setClock(new Date(Math.round(ms)));
  }

  iso(ms: number): string {
    return new Date(Math.round(ms)).toISOString();
  }

  /* ----------------------------- users ----------------------------- */

  registerUser(orgSlug: string, key: string, userId: string, organisationId: string): void {
    this.userIds.set(`${orgSlug}:${key}`, userId);
    this.userOrg.set(userId, organisationId);
  }

  user(orgSlug: string, key: string): string {
    const id = this.userIds.get(`${orgSlug}:${key}`);
    if (!id) throw new Error(`seed: unknown user ${orgSlug}:${key}`);
    return id;
  }

  /** Fresh AuthContext for a real user (clock-driven `now`, cause "seed"). Built on the root db: call it OUTSIDE transactions. */
  async ctxFor(userId: string): Promise<AuthContext> {
    const ctx = await buildContextFromDb(this.db, userId, { cause: "seed", requestId: `seed-${String(++this.requestSeq).padStart(6, "0")}` });
    if (!ctx) throw new Error(`seed: user ${userId} is missing or inactive`);
    return ctx;
  }

  async isActive(userId: string): Promise<boolean> {
    return (await buildContextFromDb(this.db, userId)) !== null;
  }

  /**
   * Runs `fn` as `userId` in one transaction, then drains the organisation's
   * pending automation runs (post-commit, like route handlers). `fn` must use
   * the `tx` only: read anything it needs from `rt.db` BEFORE calling act().
   */
  async act<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => Promise<T> | T): Promise<T> {
    const ctx = await this.ctxFor(userId);
    const result = await withTx((tx) => fn(tx, ctx), { db: this.db });
    await this.drain(ctx.organisationId);
    return result;
  }

  async drain(organisationId: string): Promise<void> {
    await runPendingAutomations(this.db, organisationId);
  }

  /* ----------------------------- queue ----------------------------- */

  schedule(at: number, label: string, run: () => Promise<void> | void): void {
    this.queue.push({ at: Math.round(at), seq: this.seq++, label, run });
  }

  get queued(): number {
    return this.queue.length;
  }

  /** Executes every queued step in (time, insertion) order. Throws on the first failure. */
  async runQueue(): Promise<void> {
    const steps = this.queue.splice(0).sort((a, b) => a.at - b.at || a.seq - b.seq);
    const started = Date.now();
    for (const [i, step] of steps.entries()) {
      if (i > 0 && i % 500 === 0) this.log(`seed: ${i}/${steps.length} steps (${this.iso(step.at).slice(0, 10)}) ${((Date.now() - started) / 1000).toFixed(1)}s`);
      if (step.at > this.nowMs) throw new Error(`seed: step "${step.label}" is scheduled in the future (${this.iso(step.at)})`);
      this.setTime(step.at);
      const t = Date.now();
      try {
        await step.run();
        this.stepsRun += 1;
        const parts = step.label.split(" ");
        const key = (step.label.startsWith("#") ? parts[2] : parts[0]) ?? "?";
        const stat = this.timings.get(key) ?? { n: 0, ms: 0 };
        stat.n += 1;
        stat.ms += Date.now() - t;
        this.timings.set(key, stat);
      } catch (err) {
        throw new Error(`seed step "${step.label}" at ${this.iso(step.at)} failed: ${describeError(err)}`, { cause: err });
      }
    }
  }

  skip(reason: string): void {
    this.skipped.push(reason);
  }
}

export function describeError(err: unknown): string {
  if (err instanceof AppError) {
    const details = err.details;
    return `${err.name} ${err.status} ${err.code}: ${err.message}${details ? ` ${JSON.stringify(details)}` : ""}`;
  }
  return rootErrorMessage(err);
}
