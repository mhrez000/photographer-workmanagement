/**
 * Seed profile "small" — the SIMPLIFICATION-PLAN §8 demo: one owner who also shoots, one extra
 * photographer ("Only their own shoots"), three editors, two clients (one on the portal), about twenty
 * jobs spread over the five stages (late ones, a Round 2, a Done-not-sent, a cancelled), time tracking
 * off, NO automations, Advanced tools off. Realistic Sydney real estate plus one wedding. "Other Studio"
 * (owner@other.test) is seeded for isolation tests exactly as in the full profile.
 *
 * Every step goes through the real services — mostly the SIMPLE composite actions (services/simple.ts),
 * so the demo history reads like the new buttons: Assign editor · Start editing · Send for checking ·
 * Approve (& send / only) · Ask for changes · Cancel. Projects are created silently from the address
 * (`autoProject`), due dates default from each type's "usual days to edit".
 */
import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { first, type Db } from "@/db/index";
import { jobs } from "@/db/schema";
import { DEFAULT_JOB_TYPES } from "@/lib/constants";
import { addCivilDays, civilDate, startOfCivilDayIso } from "@/lib/dates";
import type { AuthContext } from "@/lib/types";
import { resetClock } from "@/server/clock";
import { addComment } from "@/server/services/comments";
import { createJob } from "@/server/services/jobs";
import { createJobType } from "@/server/services/jobTypes";
import { addLink } from "@/server/services/links";
import { addNote } from "@/server/services/notes";
import { clientPortalUserIds } from "@/server/services/sharing";
import { notify } from "@/server/services/notifications";
import {
  approveJob,
  askForChanges,
  assignEditorSimple,
  cancelJobSimple,
  sendForChecking,
  setEditorUsualCapacity,
} from "@/server/services/simple";
import { runSweep } from "@/server/services/sweep";
import { inviteUser, type PreparedSecret } from "@/server/services/users";
import { deliverJob, startJob } from "@/server/services/workflow";
import type { Tx } from "@/server/services/_shared";
import { NORTHLIGHT, OWNER as FULL_OWNER, SEED_PASSWORD as DEMO_PASSWORD, TURNAROUND_DAYS, type JobTypeName, type SeedUserDef } from "./catalog";
import { bootstrapOrganisation, createDefaultWorkflow, createSeedClient } from "./org";
import { inviteSeedClientUser, postSeedClientFeedback, setSeedClientPortal } from "./portal";
import { DAY, HOUR, MINUTE, SeedRuntime } from "./runtime";
import type { SeedOptions, SeedResult } from "./index";
import { markNotificationsRead, seedOtherStudio } from "./index";

const SLUG = NORTHLIGHT.slug;
const TZ = NORTHLIGHT.timezone;

/** The owner also shoots (plan §8). Same login as the full profile. */
export const SMALL_OWNER: SeedUserDef = { ...FULL_OWNER, name: "Mo Carter", title: "Owner / Photographer" };

export const SMALL_PHOTOGRAPHER = { key: "photographer01", email: "photographer01@studio.test", name: "Priya Nair", title: "Photographer" } as const;

export const SMALL_EDITORS: readonly { key: string; email: string; name: string; title: string; colour: string; usual: number | null }[] = [
  { key: "editor01", email: "editor01@studio.test", name: "Sam Whitfield", title: "Editor", colour: "#f59e0b", usual: 6 },
  { key: "editor02", email: "editor02@studio.test", name: "Ava Mitchell", title: "Editor", colour: "#8b5cf6", usual: null },
  { key: "editor03", email: "editor03@studio.test", name: "Lucas Pham", title: "Editor", colour: "#0891b2", usual: 4 },
];

export const SMALL_CLIENTS = {
  harbourline: { name: "Harbourline Realty", contactName: "Sarah Kingsley", email: "sarah@harbourlinerealty.example", phone: "02 9310 1200" },
  coastal: { name: "Coastal Key Property", contactName: "Daniel Ward", email: "daniel@coastalkey.example", phone: "02 9317 1237" },
} as const;
type ClientKey = keyof typeof SMALL_CLIENTS;

export const SMALL_CLIENT_USER = { key: "client", email: "client@studio.test", name: "Sarah Kingsley", avatarColour: "#d97706" } as const;

/** Usual days to edit per type of shoot (plan §5; Settings → Types of shoot). */
export const SMALL_USUAL_DAYS: Record<JobTypeName, number> = { ...TURNAROUND_DAYS, Wedding: 21 };

const RAW = (slug: string) => `https://www.dropbox.com/scl/fo/northlight-${slug}/raw`;
const FINISHED = (slug: string, v = 1) => `https://drive.google.com/drive/folders/northlight-${slug}-final${v > 1 ? `-v${v}` : ""}`;

type StepFn = (tx: Tx, ctx: AuthContext, v: { jobId: string; expectedVersion: number }) => Promise<unknown>;

interface JobDef {
  actor: string;
  client: ClientKey;
  address: string;
  name: string;
  type: JobTypeName;
  photographer: string;
  /** Default: the step's instant. */
  shootMs?: number;
  /** Omitted → the type's usual days (plan §5 default); null → no due date. */
  dueDays?: number | null;
  rush?: boolean;
  instructions?: string;
  /** "Create & send to Sam": the initial editor. */
  editor?: string;
}

export async function runSmallSeed(db: Db, options: SeedOptions = {}): Promise<SeedResult> {
  const log = options.log ?? (() => {});
  const nowMs = (options.now ?? new Date()).getTime();
  const durations: Record<string, number> = {};
  let mark = Date.now();
  const lap = (name: string) => {
    const t = Date.now();
    durations[name] = t - mark;
    mark = t;
  };
  const passwordHash = await hash(DEMO_PASSWORD, options.bcryptCost ?? 10);
  const secret: PreparedSecret = { tempPassword: DEMO_PASSWORD, passwordHash };
  const rt = new SeedRuntime(db, nowMs, log);
  lap("hash");

  try {
    /* ---------------- A. structure ---------------- */
    const t0 = nowMs - 45 * DAY;
    let t = t0;
    const at = (ms: number) => {
      t = ms;
      rt.setTime(t);
    };
    const tick = (minutes = 1) => at(t + minutes * MINUTE);

    at(t0);
    const { organisationId: nl, ownerId } = await bootstrapOrganisation(rt, NORTHLIGHT, SMALL_OWNER, passwordHash);
    tick(5);
    const wf = await createDefaultWorkflow(rt, ownerId);
    tick(5);
    const jobTypes = {} as Record<JobTypeName, string>;
    for (const [i, jt] of DEFAULT_JOB_TYPES.entries()) {
      const name = jt.name as JobTypeName;
      const row = await rt.act(ownerId, (tx, ctx) =>
        createJobType(tx, ctx, { name, colour: jt.colour, workflowId: wf.id, usualDaysToEdit: SMALL_USUAL_DAYS[name], sortOrder: i }),
      );
      jobTypes[name] = row.id;
      tick(1);
    }

    // People: the extra photographer with the "Only their own shoots" preset; three editors (two with "Usually handles up to N").
    at(t0 + DAY + 9 * HOUR);
    const photographer = await rt.act(ownerId, (tx, ctx) =>
      inviteUser(
        tx,
        ctx,
        { email: SMALL_PHOTOGRAPHER.email, name: SMALL_PHOTOGRAPHER.name, role: "photographer", title: SMALL_PHOTOGRAPHER.title, avatarColour: "#22c55e", preset: "own_shoots" },
        secret,
      ),
    );
    rt.registerUser(SLUG, SMALL_PHOTOGRAPHER.key, photographer.user.id, nl);
    for (const e of SMALL_EDITORS) {
      tick(4);
      const row = await rt.act(ownerId, (tx, ctx) =>
        inviteUser(tx, ctx, { email: e.email, name: e.name, role: "editor", title: e.title, avatarColour: e.colour, flags: { canCreateJobs: false } }, secret),
      );
      rt.registerUser(SLUG, e.key, row.user.id, nl);
      if (e.usual !== null) {
        tick(1);
        await rt.act(ownerId, (tx, ctx) => setEditorUsualCapacity(tx, ctx, { userId: row.user.id, usualCapacityJobs: e.usual, expectedVersion: row.user.version }));
      }
    }

    at(t0 + DAY + 13 * HOUR);
    const clientIds = {} as Record<ClientKey, string>;
    for (const key of Object.keys(SMALL_CLIENTS) as ClientKey[]) {
      clientIds[key] = await createSeedClient(rt, ownerId, SMALL_CLIENTS[key]);
      tick(5);
    }
    // Harbourline uses the portal (and may leave feedback); Coastal Key does not.
    await setSeedClientPortal(rt, ownerId, clientIds.harbourline, { portalEnabled: true, feedbackEnabled: true });
    tick(2);
    await inviteSeedClientUser(rt, SLUG, ownerId, clientIds.harbourline, SMALL_CLIENT_USER, passwordHash);
    lap("structure");

    /* ---------------- B. jobs ---------------- */
    const N = nowMs;
    const u = (key: string) => rt.user(SLUG, key);
    const ids: Record<string, string> = {};
    const civil = (ms: number) => civilDate(new Date(ms), TZ) as string;
    const versionOf = async (jobId: string) => (await first(rt.db.select({ version: jobs.version }).from(jobs).where(eq(jobs.id, jobId))))?.version ?? 0;
    const editorOf = async (jobId: string) => (await first(rt.db.select({ editorId: jobs.editorId }).from(jobs).where(eq(jobs.id, jobId))))?.editorId ?? null;
    const sched = (ms: number, label: string, run: () => Promise<void>) => rt.schedule(ms, `small ${label}`, run);
    const step = (ms: number, key: string, label: string, actor: string | "editor", fn: StepFn) =>
      sched(ms, `${key} ${label}`, async () => {
        const jobId = ids[key];
        const who = actor === "editor" ? await editorOf(jobId) : u(actor);
        if (!who) throw new Error(`seed: ${key} has no editor for ${label}`);
        const expectedVersion = await versionOf(jobId);
        await rt.act(who, (tx, ctx) => fn(tx, ctx, { jobId, expectedVersion }));
      });

    const create = (ms: number, key: string, def: JobDef) =>
      sched(ms, `${key} create`, async () => {
        const shoot = civil(def.shootMs ?? ms);
        const res = await rt.act(u(def.actor), (tx, ctx) =>
          createJob(tx, ctx, {
            name: def.name,
            autoProject: { clientId: clientIds[def.client], address: def.address },
            jobTypeId: jobTypes[def.type],
            photographerId: u(def.photographer),
            shootDate: shoot,
            ...(def.dueDays === undefined ? {} : { dueDate: def.dueDays === null ? null : addCivilDays(shoot, def.dueDays) }),
            ...(def.rush ? { priority: "urgent" } : {}),
            ...(def.instructions ? { description: def.instructions } : {}),
            ...(def.editor ? { editorId: u(def.editor) } : {}),
          }),
        );
        ids[key] = res.job.id;
      });
    const raw = (ms: number, key: string, actor: string, slug: string) =>
      sched(ms, `${key} raw link`, async () => {
        await rt.act(u(actor), (tx, ctx) => addLink(tx, ctx, { jobId: ids[key], kind: "raw_files", url: RAW(slug), label: "Raw files" }));
      });
    const assign = (ms: number, key: string, actor: string, editor: string) =>
      step(ms, key, "assign editor", actor, (tx, ctx, v) => assignEditorSimple(tx, ctx, { ...v, editorId: u(editor) }));
    const start = (ms: number, key: string) => step(ms, key, "start editing", "editor", (tx, ctx, v) => startJob(tx, ctx, v));
    const send = (ms: number, key: string, slug: string, version = 1, note?: string) =>
      step(ms, key, "send for checking", "editor", (tx, ctx, v) =>
        sendForChecking(tx, ctx, { ...v, finishedLink: { url: FINISHED(slug, version), label: "Finished photos" }, ...(note ? { note } : {}) }),
      );
    const approve = (ms: number, key: string, actor: string, share: "send" | "only" | "n/a") =>
      step(ms, key, `approve (${share})`, actor, (tx, ctx, v) => approveJob(tx, ctx, { ...v, share }));
    const changes = (ms: number, key: string, actor: string, note: string, chips: string[], neededBy?: string) =>
      step(ms, key, "ask for changes", actor, (tx, ctx, v) => askForChanges(tx, ctx, { ...v, note, chips, ...(neededBy ? { neededBy } : {}) }));
    const deliverOnly = (ms: number, key: string, actor: string) =>
      step(ms, key, "send to client", actor, (tx, ctx, v) => deliverJob(tx, ctx, { ...v, delivery: { shareJob: true } }));
    const cancel = (ms: number, key: string, actor: string, reason: string) =>
      step(ms, key, "cancel", actor, (tx, ctx, v) => cancelJobSimple(tx, ctx, { ...v, reason }));
    const note = (ms: number, key: string, actor: string, kind: "photographer" | "internal" | "delivery", body: string) =>
      sched(ms, `${key} note ${kind}`, async () => {
        await rt.act(u(actor), (tx, ctx) => addNote(tx, ctx, { jobId: ids[key], kind, body }));
      });
    const message = (ms: number, key: string, actor: string | "editor", body: string, kind: "comment" | "question" = "comment") =>
      sched(ms, `${key} message`, async () => {
        const who = actor === "editor" ? await editorOf(ids[key]) : u(actor);
        if (!who) return rt.skip(`${key} message: no editor`);
        await rt.act(who, (tx, ctx) => addComment(tx, ctx, { jobId: ids[key], body, kind }));
      });

    const HL: ClientKey = "harbourline";
    const CK: ClientKey = "coastal";
    /** `d` civil days ago at `h`:00 in the studio timezone. */
    const day = (d: number, h = 9) => Date.parse(startOfCivilDayIso(addCivilDays(civil(N), -d), TZ)) + h * HOUR;

    // ---- Done (6) ----
    // D1 — Harbourline, owner's shoot, approve & send (Approved → Delivered → Completed), delivery note, feedback thread.
    create(day(12, 8), "D1", { actor: "owner", client: HL, address: "14 Ocean Street, Bondi NSW 2026", name: "14 Ocean Street · Listing photos", type: "Real Estate", photographer: "owner", editor: "editor01", instructions: "Lift the exteriors and swap the sky on the hero. Vendor wants the pool featured." });
    raw(day(12, 8) + 10 * MINUTE, "D1", "owner", "14-ocean-street");
    start(day(12, 10), "D1");
    send(day(12, 16), "D1", "14-ocean-street");
    note(day(11, 9), "D1", "owner", "delivery", "Your listing photos are ready: 32 images, web and print sizes. The gallery link stays live for 90 days.");
    approve(day(11, 9) + 5 * MINUTE, "D1", "owner", "send");
    sched(day(2, 10), "D1 client feedback", async () => {
      ids["D1-feedback"] = await postSeedClientFeedback(rt, u("client"), ids.D1, "Love these! Could the hero shot be a touch warmer? The vendor wants it to feel like summer.");
    });
    sched(day(1, 9), "D1 owner reply", async () => {
      await rt.act(u("owner"), async (tx, ctx) => {
        const reply = await addComment(tx, ctx, { jobId: ids.D1, kind: "client_feedback", parentCommentId: ids["D1-feedback"], body: "Thanks Sarah! We'll warm up the hero and re-share it by tomorrow afternoon." });
        const job = await first(tx.select().from(jobs).where(eq(jobs.id, ids.D1)));
        if (!job) return;
        await notify(tx, ctx, {
          userIds: await clientPortalUserIds(tx, ctx.organisationId, job.clientId),
          type: "client_feedback_reply",
          title: `The studio replied on ${job.name}`,
          body: reply.comment.body,
          jobId: job.id,
          linkPath: `/portal/jobs/${job.id}`,
        });
      });
    });
    sched(N - 6 * HOUR, "D1 client follow-up", async () => {
      await postSeedClientFeedback(rt, u("client"), ids.D1, "Great, thank you. Could we also get a square crop of the hero for Instagram?", ids["D1-feedback"]);
    });

    // D2 — Coastal Key (no portal): approve → finishes straight away (n/a). Shot by the owner, edited by editor02.
    create(day(7, 8), "D2", { actor: "owner", client: CK, address: "38 Arden Street, Coogee NSW 2034", name: "38 Arden Street · Sales campaign photos", type: "Real Estate", photographer: "owner", editor: "editor02" });
    raw(day(7, 8) + 15 * MINUTE, "D2", "owner", "38-arden-street");
    start(day(7, 11), "D2");
    send(day(7, 17), "D2", "38-arden-street");
    approve(day(6, 9), "D2", "owner", "n/a");

    // D3 — one round of changes, then done (n/a); sent late (after the due date) so it counts against the editor.
    create(day(14, 8), "D3", { actor: "owner", client: CK, address: "5 Carr Street, Coogee NSW 2034", name: "5 Carr Street · Pre-auction photos", type: "Real Estate", photographer: "owner", editor: "editor03" });
    raw(day(14, 8) + 10 * MINUTE, "D3", "owner", "5-carr-street");
    start(day(14, 10), "D3");
    send(day(12, 10), "D3", "5-carr-street"); // due was shoot + 1 day → late
    changes(day(12, 11), "D3", "owner", "The kitchen reads too warm next to the exteriors and the verticals lean in the hallway.", ["Colour", "Straighten"]);
    send(day(11, 15), "D3", "5-carr-street", 2, "Neutralised the kitchen and fixed the verticals.");
    approve(day(11, 16), "D3", "owner", "n/a");

    // D4 — Approve only: Done · "Not sent to client" (Harbourline), 1 day ago.
    create(day(3, 8), "D4", { actor: "owner", client: HL, address: "7/22 Campbell Parade, Bondi Beach NSW 2026", name: "7/22 Campbell Parade · Listing photos", type: "Real Estate", photographer: "owner", editor: "editor01" });
    raw(day(3, 8) + 10 * MINUTE, "D4", "owner", "7-22-campbell-parade");
    start(day(3, 10), "D4");
    send(day(2, 9), "D4", "7-22-campbell-parade");
    approve(day(1, 10), "D4", "owner", "only");

    // D5 — Approve only, then "Send to client" separately (Delivered, shared), 2 days ago.
    create(day(5, 8), "D5", { actor: "owner", client: HL, address: "14 Ocean Street, Bondi NSW 2026", name: "14 Ocean Street · Twilight hero shots", type: "Twilight", photographer: "owner", editor: "editor02" });
    raw(day(5, 8) + 10 * MINUTE, "D5", "owner", "14-ocean-twilight");
    start(day(5, 12), "D5");
    send(day(4, 11), "D5", "14-ocean-twilight");
    approve(day(3, 9), "D5", "owner", "only");
    deliverOnly(day(2, 9), "D5", "owner");

    // D6 — the wedding: shot 25 days ago, usual 21 days, sent on time, approve & send? No portal → n/a.
    create(day(25, 8), "D6", { actor: "owner", client: CK, address: "Whitaker Wedding, Bendooley Estate", name: "Whitaker Wedding · Wedding day edit", type: "Wedding", photographer: "owner", editor: "editor02", instructions: "Ceremony was backlit — heavy recovery on the aisle shots. Couple asked for a few black-and-white portraits." });
    raw(day(25, 8) + 20 * MINUTE, "D6", "owner", "whitaker-wedding");
    start(day(24, 9), "D6");
    message(day(20, 14), "D6", "editor", "Quick question: window pulls on the reception room, or keep the view soft?", "question");
    message(day(20, 15), "D6", "owner", "Keep the view soft — the couple loved the haze.");
    send(day(6, 16), "D6", "whitaker-wedding");
    approve(day(5, 10), "D6", "owner", "n/a");

    // D7 — photographer01's own shoot, checked by photographer01 (decision 4), done 8 days ago.
    create(day(9, 8), "D7", { actor: "photographer01", client: CK, address: "9 Beach Road, Coogee NSW 2034", name: "9 Beach Road · Listing photos", type: "Real Estate", photographer: "photographer01", editor: "editor03" });
    raw(day(9, 8) + 10 * MINUTE, "D7", "photographer01", "9-beach-road");
    start(day(9, 10), "D7");
    send(day(9, 15), "D7", "9-beach-road");
    approve(day(8, 9), "D7", "photographer01", "n/a");

    // ---- Changes asked (2) ----
    // C1 — asked yesterday, needed back today.
    create(day(3, 8), "C1", { actor: "owner", client: HL, address: "101 Ramsgate Avenue, North Bondi NSW 2026", name: "101 Ramsgate Avenue · Listing photos", type: "Real Estate", photographer: "owner", editor: "editor01", dueDays: 3 });
    raw(day(3, 8) + 10 * MINUTE, "C1", "owner", "101-ramsgate-avenue");
    start(day(3, 9), "C1");
    send(day(2, 16), "C1", "101-ramsgate-avenue");
    changes(day(1, 10), "C1", "owner", "Please remove the bins on the side path and the agent's car from the driveway shot.", ["Remove items"], civil(N));
    // C2 — asked 3 days ago, needed back 2 days ago: LATE with the editor.
    create(day(6, 8), "C2", { actor: "owner", client: CK, address: "12 Short Street, Birchgrove NSW 2041", name: "12 Short Street · Listing photos", type: "Real Estate", photographer: "owner", editor: "editor03", dueDays: 2 });
    raw(day(6, 8) + 10 * MINUTE, "C2", "owner", "12-short-street");
    start(day(6, 10), "C2");
    send(day(5, 15), "C2", "12-short-street");
    changes(day(3, 9), "C2", "owner", "The sky on the front elevation is blown out and the living room is too dark.", ["Sky", "Colour"], civil(day(2)));
    message(day(2, 16), "C2", "editor", "Running behind on this one, sorry — I'll have it back first thing tomorrow.");

    // ---- Ready to check (4) ----
    // R1 — sent 5 hours ago (first round).
    create(day(1, 8), "R1", { actor: "owner", client: HL, address: "15 Hastings Parade, North Bondi NSW 2026", name: "15 Hastings Parade · Listing photos", type: "Real Estate", photographer: "owner", editor: "editor01" });
    raw(day(1, 8) + 10 * MINUTE, "R1", "owner", "15-hastings-parade");
    start(day(1, 9), "R1");
    send(N - 5 * HOUR, "R1", "15-hastings-parade");
    // R2 — sent 2 days ago: the owner's own delay ("Waiting on you · oldest 2 days").
    create(day(4, 8), "R2", { actor: "owner", client: CK, address: "40 Burns Bay Road, Lane Cove NSW 2066", name: "40 Burns Bay Road · Listing photos", type: "Real Estate", photographer: "owner", editor: "editor02", dueDays: 2 });
    raw(day(4, 8) + 10 * MINUTE, "R2", "owner", "40-burns-bay-road");
    start(day(4, 10), "R2");
    send(day(2, 12), "R2", "40-burns-bay-road");
    // R3 — Round 2: changes asked, sent back 3 hours ago.
    create(day(3, 8), "R3", { actor: "owner", client: HL, address: "8 Penrose Street, Lane Cove West NSW 2066", name: "8 Penrose Street · Listing photos", type: "Real Estate", photographer: "owner", editor: "editor01", dueDays: 3, rush: true });
    raw(day(3, 8) + 10 * MINUTE, "R3", "owner", "8-penrose-street");
    start(day(3, 9), "R3");
    send(day(2, 15), "R3", "8-penrose-street");
    changes(day(2, 16), "R3", "owner", "Two frames are missing from the set (ensuite and laundry) and the hero needs a tighter crop.", ["Missing photos", "Crop"]);
    send(N - 3 * HOUR, "R3", "8-penrose-street", 2, "Added the two frames and re-cropped the hero.");
    // R4 — photographer01's shoot, sent yesterday: she checks it herself.
    create(day(2, 8), "R4", { actor: "photographer01", client: CK, address: "2/9 North Steyne, Manly NSW 2095", name: "2/9 North Steyne · Listing photos", type: "Real Estate", photographer: "photographer01", editor: "editor03", dueDays: 2 });
    raw(day(2, 8) + 10 * MINUTE, "R4", "photographer01", "2-9-north-steyne");
    start(day(2, 10), "R4");
    send(day(1, 14), "R4", "2-9-north-steyne");

    // ---- With editor (5) ----
    // W1 — assigned, not started, due tomorrow.
    create(N - 5 * HOUR, "W1", { actor: "owner", client: HL, address: "44 Pittwater Road, Manly NSW 2095", name: "44 Pittwater Road · Listing photos", type: "Real Estate", photographer: "owner", editor: "editor02" });
    raw(N - 5 * HOUR + 10 * MINUTE, "W1", "owner", "44-pittwater-road");
    // W2 — assigned 2 days ago, never started, due yesterday: LATE, not started.
    create(day(2, 8), "W2", { actor: "owner", client: CK, address: "6 Bay Street, Rockdale NSW 2216", name: "6 Bay Street · Drone stills", type: "Drone", photographer: "owner", editor: "editor03" });
    raw(day(2, 8) + 10 * MINUTE, "W2", "owner", "6-bay-street-drone");
    // W3 — editing, due today.
    create(day(1, 8), "W3", { actor: "owner", client: HL, address: "27 Glenmore Road, Paddington NSW 2021", name: "27 Glenmore Road · Listing photos", type: "Real Estate", photographer: "owner", editor: "editor01" });
    raw(day(1, 8) + 10 * MINUTE, "W3", "owner", "27-glenmore-road");
    start(day(1, 11), "W3");
    note(day(1, 8) + 12 * MINUTE, "W3", "owner", "internal", "Paddington & Co trial job — make it count.");
    // W4 — editing since yesterday, floor plan, due in 2 days.
    create(day(1, 8), "W4", { actor: "owner", client: CK, address: "38 Arden Street, Coogee NSW 2034", name: "38 Arden Street · Floor plan", type: "Floor Plans", photographer: "owner", editor: "editor02", dueDays: 3 });
    raw(day(1, 8) + 15 * MINUTE, "W4", "owner", "38-arden-floor-plan");
    start(day(1, 13), "W4");
    // W5 — created "Decide later", given to Lucas an hour on (the separate Assign step), editing, LATE (due 2 days ago).
    create(day(4, 8), "W5", { actor: "owner", client: CK, address: "61 Underwood Street, Paddington NSW 2021", name: "61 Underwood Street · Listing photos", type: "Real Estate", photographer: "owner", dueDays: 2 });
    raw(day(4, 8) + 10 * MINUTE, "W5", "owner", "61-underwood-street");
    assign(day(4, 9), "W5", "owner", "editor03");
    start(day(4, 10), "W5");
    message(day(3, 9), "W5", "owner", "Any chance we can have the first 10 selects early? The agent wants them for tonight's email.");

    // ---- Needs editor (3) ----
    // N1 — shot this morning, "Decide later".
    create(N - 3 * HOUR, "N1", { actor: "owner", client: HL, address: "3 Wolseley Road, Point Piper NSW 2027", name: "3 Wolseley Road · Listing photos", type: "Real Estate", photographer: "owner" });
    raw(N - 3 * HOUR + 10 * MINUTE, "N1", "owner", "3-wolseley-road");
    // N2 — shot yesterday, due yesterday, still nobody: LATE and needs an editor.
    create(day(1, 8) + 2 * HOUR, "N2", { actor: "owner", client: CK, address: "18 Bellevue Road, Bellevue Hill NSW 2023", name: "18 Bellevue Road · Twilight exteriors", type: "Twilight", photographer: "owner", dueDays: 0 });
    raw(day(1, 8) + 2 * HOUR + 10 * MINUTE, "N2", "owner", "18-bellevue-road");
    // N3 — photographer01's shoot an hour ago, no editor yet.
    create(N - HOUR, "N3", { actor: "photographer01", client: CK, address: "9 Beach Road, Coogee NSW 2034", name: "9 Beach Road · Drone stills", type: "Drone", photographer: "photographer01" });
    raw(N - HOUR + 10 * MINUTE, "N3", "photographer01", "9-beach-road-drone");

    // ---- Cancelled (1) ----
    create(day(6, 8), "X1", { actor: "owner", client: HL, address: "14 Ocean Street, Bondi NSW 2026", name: "14 Ocean Street · Drone stills", type: "Drone", photographer: "owner" });
    cancel(day(4, 9), "X1", "owner", "Drone permit for the beachfront was refused");

    log(`seed(small): ${rt.queued} steps queued`);
    await rt.runQueue();
    lap("history");

    /* ---------------- C. Other Studio, notifications, final sweep ---------------- */
    const otherStudioId = await seedOtherStudio(rt, passwordHash, secret);
    lap("other studio");
    const notificationsRead = await markNotificationsRead(rt);
    lap("notifications");
    rt.setTime(nowMs);
    const finalSweeps = [await runSweep(db, nl), await runSweep(db, otherStudioId)];
    for (const r of finalSweeps) if (r.errors.length > 0) throw new Error(`final sweep errors: ${JSON.stringify(r.errors)}`);
    lap("final sweep");

    return { northlightId: nl, otherStudioId, stepsRun: rt.stepsRun, skipped: rt.skipped, durationsMs: durations, finalSweeps, notificationsRead };
  } finally {
    resetClock();
  }
}
