import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commentMentions, jobComments, jobLinks, jobNotes, organisationSettings, workSessions } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, setUserFlags, type SeedIds, type TestDb } from "@/db/test-db";
import { newId } from "@/lib/ids";
import { NotFoundError } from "@/server/errors";
import { getJobHistory } from "./jobHistory";
import { getJobDetail } from "./jobDetail";
import { reattribute } from "./test-history";

const NOW = "2026-10-08T00:00:00.000Z";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(async () => fakeClock.reset());

const ctxOf = async (key: keyof SeedIds["users"]) => await contextFor(db, ids.users[key]);

async function inProgressJob() {
  return (await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1, photographerId: ids.users.photographer1 })).job;
}

describe("getJobDetail access", () => {
  it("404s for foreign, missing and not-visible jobs", async () => {
    const job = await inProgressJob();
    const other = await seedMinimalOrg(db, { slug: "other" });
    const foreign = (await insertJobFixture(db, other, { statusKey: "in_progress" })).job;
    await expect(getJobDetail(db, await ctxOf("owner"), foreign.id)).rejects.toThrow(NotFoundError);
    await expect(getJobDetail(db, await ctxOf("owner"), "missing")).rejects.toThrow(NotFoundError);
    await expect(getJobDetail(db, await ctxOf("photographer2"), job.id)).rejects.toThrow(NotFoundError);
    await expect(getJobDetail(db, await ctxOf("editor2"), job.id)).rejects.toThrow(NotFoundError);
    await expect(getJobHistory(db, await ctxOf("editor2"), job.id)).rejects.toThrow(NotFoundError);
    expect((await getJobDetail(db, await ctxOf("editor1"), job.id)).job.id).toBe(job.id);
    expect((await getJobDetail(db, await contextFor(db, other.users.owner), foreign.id)).job.id).toBe(foreign.id);
  });
});

describe("getJobDetail redaction", () => {
  it("hides internal notes from editors (and from photographers on others' jobs)", async () => {
    const job = await inProgressJob();
    for (const [kind, author] of [
      ["internal", ids.users.coAdmin],
      ["editor", ids.users.editor1],
      ["photographer", ids.users.photographer1],
    ] as const) {
      await db.insert(jobNotes).values({ organisationId: ids.organisationId, jobId: job.id, kind, body: `${kind} note`, authorUserId: author });
    }
    const kinds = async (key: keyof SeedIds["users"]) => (await getJobDetail(db, await ctxOf(key), job.id)).notes.map((n) => n.kind).sort();
    expect(await kinds("owner")).toEqual(["editor", "internal", "photographer"]);
    expect(await kinds("coAdmin")).toEqual(["editor", "internal", "photographer"]);
    expect(await kinds("photographer1")).toEqual(["editor", "internal", "photographer"]);
    expect(await kinds("editor1")).toEqual(["editor", "photographer"]);
  });

  it("shows other people's work sessions only with timer.view_others", async () => {
    await db.update(organisationSettings).set({ timeTrackingEnabled: true }).where(eq(organisationSettings.organisationId, ids.organisationId));
    const fx = await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 });
    await db.insert(workSessions).values({
      organisationId: ids.organisationId,
      jobId: fx.job.id,
      userId: ids.users.editor1,
      statusIdAtStart: ids.statuses.in_progress,
      categoryAtStart: "in_progress",
      transitionId: fx.transitionId,
      startedAt: NOW,
    });
    fakeClock.advanceMinutes(30);
    const asEditor = await getJobDetail(db, await ctxOf("editor1"), fx.job.id);
    expect(asEditor.sessions).toHaveLength(1);
    expect(asEditor.runningSession).toMatchObject({ isRunning: true, durationSeconds: 1800, statusName: "In Progress" });
    expect(asEditor.metrics.activeEditingSeconds).toBe(1800);
    expect(asEditor.stages[0].activeSeconds).toBe(1800);
    expect(asEditor.actions.canUseTimer).toBe(true);
    expect((await getJobDetail(db, await ctxOf("coAdmin"), fx.job.id)).sessions).toHaveLength(1);
    // The job's photographer (own job → timer.view_others) sees it too.
    expect((await getJobDetail(db, await ctxOf("photographer1"), fx.job.id)).sessions).toHaveLength(1);
  });

  it("blanks deleted comment bodies, nests replies, exposes canEdit within the window", async () => {
    const job = await inProgressJob();
    const rootId = newId();
    await db
      .insert(jobComments)
      .values({
        id: rootId,
        organisationId: ids.organisationId,
        jobId: job.id,
        rootCommentId: rootId,
        authorUserId: ids.users.photographer1,
        body: "Please check the sky",
        createdAt: NOW,
      });
    const replyId = newId();
    await db
      .insert(jobComments)
      .values({
        id: replyId,
        organisationId: ids.organisationId,
        jobId: job.id,
        parentCommentId: rootId,
        rootCommentId: rootId,
        authorUserId: ids.users.editor1,
        body: "On it @Pia",
        createdAt: NOW,
      });
    await db.insert(commentMentions).values({ organisationId: ids.organisationId, commentId: replyId, mentionedUserId: ids.users.photographer1 });
    const goneId = newId();
    await db
      .insert(jobComments)
      .values({
        id: goneId,
        organisationId: ids.organisationId,
        jobId: job.id,
        rootCommentId: goneId,
        authorUserId: ids.users.editor1,
        body: "secret",
        createdAt: NOW,
      });
    await db.update(jobComments).set({ deletedAt: NOW, deletedByUserId: ids.users.editor1 }).where(eq(jobComments.id, goneId));

    fakeClock.advanceMinutes(5);
    const detail = await getJobDetail(db, await ctxOf("editor1"), job.id);
    expect(detail.comments).toHaveLength(2);
    const root = detail.comments.find((c) => c.id === rootId);
    expect(root?.replies.map((r) => r.id)).toEqual([replyId]);
    expect(root?.canEdit).toBe(false); // not the author
    expect(root?.replies[0]).toMatchObject({ canEdit: true, mentions: [{ id: ids.users.photographer1 }] });
    const gone = detail.comments.find((c) => c.id === goneId);
    expect(gone).toMatchObject({ body: null, canEdit: false });

    fakeClock.advanceMinutes(20);
    expect((await getJobDetail(db, await ctxOf("editor1"), job.id)).comments.find((c) => c.id === rootId)?.replies[0].canEdit).toBe(false);
  });
});

describe("getJobDetail links, actions, metrics", () => {
  it("builds link slots from the supersession chain and picks the primary link", async () => {
    const job = await inProgressJob();
    const first = (
      await db
        .insert(jobLinks)
        .values({
          organisationId: ids.organisationId,
          jobId: job.id,
          kind: "raw_files",
          url: "https://drive.example/a",
          addedByUserId: ids.users.photographer1,
          createdAt: NOW,
        })
        .returning()
    )[0];
    fakeClock.advanceMinutes(1);
    const second = (
      await db
        .insert(jobLinks)
        .values({
          organisationId: ids.organisationId,
          jobId: job.id,
          kind: "raw_files",
          url: "https://drive.example/b",
          addedByUserId: ids.users.photographer1,
          supersedesLinkId: first.id,
          createdAt: fakeClock.now(),
        })
        .returning()
    )[0];
    await db.update(jobLinks).set({ supersededAt: fakeClock.now(), supersededByLinkId: second.id }).where(eq(jobLinks.id, first.id));
    await db
      .insert(jobLinks)
      .values({
        organisationId: ids.organisationId,
        jobId: job.id,
        kind: "finished_files",
        url: "https://drive.example/final",
        addedByUserId: ids.users.editor1,
        createdAt: fakeClock.now(),
      });

    const detail = await getJobDetail(db, await ctxOf("owner"), job.id);
    const raw = detail.links.find((s) => s.kind === "raw_files");
    expect(raw?.history.map((l) => l.url)).toEqual(["https://drive.example/a", "https://drive.example/b"]);
    expect(raw?.current?.url).toBe("https://drive.example/b");
    expect(raw?.history[0].isCurrent).toBe(false);
    expect(detail.links.map((s) => s.kind)).toEqual(["raw_files", "finished_files"]);
    expect(detail.finishedWork.map((l) => l.url)).toEqual(["https://drive.example/final"]);
    expect(detail.job.primaryLink?.url).toBe("https://drive.example/final");
  });

  it("actions reflect the actor's role", async () => {
    const job = await inProgressJob();
    const editor = (await getJobDetail(db, await ctxOf("editor1"), job.id)).actions;
    expect(editor.transitions.map((t) => t.toStatus.key)).toEqual(["submitted"]);
    expect(editor).toMatchObject({ canAssignEditor: false, canCancel: false, canEditFields: false, canPause: true, canComment: true });
    expect(editor.canAddNoteKinds).toEqual(["editor", "revision"]);

    const photographer = (await getJobDetail(db, await ctxOf("photographer1"), job.id)).actions;
    expect(photographer.transitions.map((t) => t.toStatus.key)).not.toContain("submitted");
    expect(photographer).toMatchObject({ canAssignEditor: true, canCancel: true, canEditFields: true, canPause: false });
    expect(photographer.canAddNoteKinds).not.toContain("internal");

    const coAdmin = (await getJobDetail(db, await ctxOf("coAdmin"), job.id)).actions;
    expect(coAdmin.transitions.map((t) => t.toStatus.key)).toContain("submitted");
    expect(coAdmin.canAddNoteKinds).toContain("internal");
  });

  it("returns workflow statuses, stages and live metrics", async () => {
    const job = await inProgressJob();
    fakeClock.advanceHours(3);
    const detail = await getJobDetail(db, await ctxOf("owner"), job.id);
    expect(detail.workflowStatuses).toHaveLength(13);
    expect(detail.stages).toHaveLength(1);
    expect(detail.stages[0]).toMatchObject({ kind: "creation", isCurrent: true, durationSeconds: 10800, toStatus: { key: "in_progress" } });
    expect(detail.metrics).toMatchObject({
      timeInCurrentStatusSeconds: 10800,
      editingSeconds: 10800,
      reviewSeconds: 0,
      turnaroundSeconds: null,
      activeEditingSeconds: null,
    });
    expect(detail.assignments.map((a) => a.role).sort()).toEqual(["editor", "photographer"]);
    expect(detail.job.createdBy.id).toBe(ids.users.photographer1);
    expect(detail.openRevision).toBeNull();

    const history = await getJobHistory(db, await ctxOf("owner"), job.id);
    expect(history.map((h) => h.kind)).toEqual(["stage", "event"]);
    expect(history[1].event?.eventType).toBe("job.created");
  });
});

describe("getJobDetail — roles v2 privacy (§2.3, §2.4)", () => {
  it("note kinds per persona: editors never internal/client, ⚑all members internal only on managed jobs, delivery notes for all staff", async () => {
    const job = await inProgressJob();
    for (const [kind, author] of [
      ["internal", ids.users.owner],
      ["client", ids.users.owner],
      ["delivery", ids.users.owner],
      ["editor", ids.users.editor1],
    ] as const) {
      await db.insert(jobNotes).values({ organisationId: ids.organisationId, jobId: job.id, kind, body: `${kind} note`, authorUserId: author });
    }
    const kinds = async (key: keyof SeedIds["users"]) => (await getJobDetail(db, await ctxOf(key), job.id)).notes.map((n) => n.kind).sort();
    expect(await kinds("owner")).toEqual(["client", "delivery", "editor", "internal"]);
    expect(await kinds("photographer1")).toEqual(["client", "delivery", "editor", "internal"]); // manages the job
    expect(await kinds("lead")).toEqual(["client", "delivery", "editor"]); // sees all jobs, does not manage this one
    expect(await kinds("editor1")).toEqual(["delivery", "editor"]);
  });

  it("clients never open a staff job detail (404), not even a job shared with them", async () => {
    const shared = (await insertJobFixture(db, ids, { statusKey: "delivered", sharedWithClient: true })).job;
    await expect(getJobDetail(db, await ctxOf("client"), shared.id)).rejects.toThrow(NotFoundError);
    await expect(getJobHistory(db, await ctxOf("client"), shared.id)).rejects.toThrow(NotFoundError);
    const detail = await getJobDetail(db, await ctxOf("owner"), shared.id);
    expect(detail.job).toMatchObject({ sharedWithClient: true, projectSharedWithClient: false, createdByRole: "photographer" });
  });

  it("a past editor sees the job up to their cut-off: later comments, notes, links and the new holder are hidden", async () => {
    const job = await inProgressJob();
    await db.insert(jobComments).values({ organisationId: ids.organisationId, jobId: job.id, authorUserId: ids.users.photographer1, body: "before", createdAt: NOW });
    await db.insert(jobNotes).values({ organisationId: ids.organisationId, jobId: job.id, kind: "editor", body: "mine", authorUserId: ids.users.editor1, createdAt: NOW, updatedAt: NOW });
    fakeClock.advanceMinutes(5);
    await reattribute(db, ids, job.id, ids.users.editor2, fakeClock.now());
    fakeClock.advanceMinutes(5);
    await db.insert(jobComments).values({ organisationId: ids.organisationId, jobId: job.id, authorUserId: ids.users.photographer1, body: "after", createdAt: fakeClock.now() });
    await db.insert(jobNotes).values({ organisationId: ids.organisationId, jobId: job.id, kind: "editor", body: "theirs", authorUserId: ids.users.editor2, createdAt: fakeClock.now(), updatedAt: fakeClock.now() });
    await db.insert(jobLinks).values({ organisationId: ids.organisationId, jobId: job.id, kind: "finished_files", url: "https://x.example/new", addedByUserId: ids.users.editor2, createdAt: fakeClock.now() });

    const past = await getJobDetail(db, await ctxOf("editor1"), job.id);
    expect(past.comments.map((c) => c.body)).toEqual(["before"]);
    expect(past.notes.map((n) => n.body)).toEqual(["mine"]);
    expect(past.links).toEqual([]);
    expect(past.job.editor?.name).toBe("Another editor");
    expect(past.assignments.some((a) => a.user.id === ids.users.editor2)).toBe(false);
    expect(past.assignments.every((a) => a.reason === null || a.user.id === ids.users.editor1)).toBe(true);
    // the current holder sees everything
    const holder = await getJobDetail(db, await ctxOf("editor2"), job.id);
    expect(holder.comments.map((c) => c.body)).toEqual(["before", "after"]);
    expect(holder.job.editor?.id).toBe(ids.users.editor2);
    // an editor with "See other editors' jobs" sees the full job (minus §2.4)
    await setUserFlags(db, ids.users.editor1, { canViewTeamJobs: true });
    expect((await getJobDetail(db, await ctxOf("editor1"), job.id)).job.editor?.id).toBe(ids.users.editor2);
    // history stages after the cut-off hide the actor for the past editor
    await setUserFlags(db, ids.users.editor1, { canViewTeamJobs: false });
    const history = await getJobHistory(db, await ctxOf("editor1"), job.id);
    const lastStage = history.filter((h) => h.kind === "stage").at(-1)?.stage;
    expect(lastStage?.editorAtEntry?.name).toBe("Another editor");
    expect(lastStage?.actor).toBeNull();
  });
});
