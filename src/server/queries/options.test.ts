/**
 * Picker options (docs/ROLES.md §3.4): job-creation options are separate
 * queries with a minimal projection; user options never leak client users
 * or emails to non-admins; `jobId` needs comment.mention; clients get 403.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { clients, jobAssignments, projects } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, setUserFlags, type SeedIds, type TestDb } from "@/db/test-db";
import { editorPickerOptions } from "./editors";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { getClientOptions, getProjectOptions, getUserOptions } from "./options";

const NOW = "2026-10-08T00:00:00.000Z";
let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  await db.update(clients).set({ email: "sarah@harbour.example", contactName: "Sarah" }).where(eq(clients.id, ids.clientId));
  await db.insert(clients).values({ id: "c-old", organisationId: ids.organisationId, name: "Archived Co", archivedAt: NOW, createdAt: NOW, updatedAt: NOW });
});
afterEach(() => fakeClock.reset());

const ctxOf = async (key: keyof SeedIds["users"]) => await contextFor(db, ids.users[key]);

describe("getClientOptions / getProjectOptions", () => {
  it("editors who can create jobs get every non-archived client and project, id/name/colour only", async () => {
    const e1 = await ctxOf("editor1"); // no visible jobs at all
    const opts = await getClientOptions(db, e1);
    expect(opts.map((c) => c.id).sort()).toEqual([ids.clientId, ids.clientId2].sort());
    expect(Object.keys(opts[0]).sort()).toEqual(["colour", "id", "name"]);
    expect(await getClientOptions(db, e1, { q: "harbour" })).toHaveLength(1);
    expect(await getClientOptions(db, e1, { q: "sarah" })).toEqual([]); // name only
    const projectOpts = await getProjectOptions(db, e1, { clientId: ids.clientId });
    expect(projectOpts.map((p) => p.id)).toEqual([ids.projectId]);
    expect(Object.keys(projectOpts[0]).sort()).toEqual(["clientId", "clientName", "id", "name"]);
  });

  it("without Create jobs an editor only gets clients / projects of jobs visible to them", async () => {
    await setUserFlags(db, ids.users.editor1, { canCreateJobs: false });
    expect(await getClientOptions(db, await ctxOf("editor1"))).toEqual([]);
    await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 });
    expect((await getClientOptions(db, await ctxOf("editor1"))).map((c) => c.id)).toEqual([ids.clientId]);
    expect((await getProjectOptions(db, await ctxOf("editor1"))).map((p) => p.id)).toEqual([ids.projectId]);
  });

  it("clients get 403; archived clients and projects of archived clients never appear", async () => {
    await db.insert(projects).values({ id: "p-old", organisationId: ids.organisationId, clientId: "c-old", name: "Old project", createdAt: NOW, updatedAt: NOW });
    const owner = await ctxOf("owner");
    expect((await getClientOptions(db, owner)).some((c) => c.id === "c-old")).toBe(false);
    expect((await getProjectOptions(db, owner)).some((p) => p.id === "p-old")).toBe(false);
    await expect(getClientOptions(db, await ctxOf("client"))).rejects.toThrow(ForbiddenError);
    await expect(getProjectOptions(db, await ctxOf("client"))).rejects.toThrow(ForbiddenError);
  });
});

describe("getUserOptions", () => {
  it("reduced projection, staff only for non-admins; role=client is a 400 for them", async () => {
    const people = await getUserOptions(db, await ctxOf("photographer1"));
    expect(people.some((u) => u.role === "client")).toBe(false);
    expect(people.every((u) => !("email" in u))).toBe(true);
    expect(people.find((u) => u.id === ids.users.owner)).toMatchObject({ isAdmin: true, isPrimaryOwner: true });
    await expect(getUserOptions(db, await ctxOf("photographer1"), { role: "client" })).rejects.toThrow(ValidationError);
    expect((await getUserOptions(db, await ctxOf("owner"), { role: "client" })).map((u) => u.id).sort()).toEqual([ids.users.client, ids.users.client2].sort());
  });

  it("role=photographer (the job-create picker) lists active photographers for creators", async () => {
    const forEditor = await getUserOptions(db, await ctxOf("editor1"), { role: "photographer" });
    expect(forEditor.map((u) => u.id).sort()).toEqual([ids.users.owner, ids.users.coAdmin, ids.users.lead, ids.users.photographer1, ids.users.photographer2].sort());
    expect(forEditor.every((u) => u.role === "photographer" && u.isActive)).toBe(true);
  });

  it("jobId needs comment.mention on the job: invisible → 404, past editor → 403, assigned editor → viewers", async () => {
    const job = (await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 })).job;
    await expect(getUserOptions(db, await ctxOf("editor2"), { jobId: job.id })).rejects.toThrow(NotFoundError);
    await db.insert(jobAssignments).values({
      organisationId: ids.organisationId,
      jobId: job.id,
      role: "editor",
      userId: ids.users.editor2,
      assignedAt: "2026-10-01T00:00:00.000Z",
      unassignedAt: "2026-10-02T00:00:00.000Z",
      unassignReason: "reassigned",
    });
    await expect(getUserOptions(db, await ctxOf("editor2"), { jobId: job.id })).rejects.toThrow(ForbiddenError);
    const viewers = await getUserOptions(db, await ctxOf("editor1"), { jobId: job.id, excludeSelf: "1" });
    // The roster scope (E17) applies on top of "who may view the job": the owner (created it) and the shooter,
    // never the other editor who once held it — editors only ever see the photographers on their jobs.
    expect(viewers.map((u) => u.id).sort()).toEqual([ids.users.coAdmin, ids.users.owner, ids.users.photographer1].sort());
    expect(viewers.map((u) => u.id)).not.toContain(ids.users.editor1);
    expect(viewers.map((u) => u.id)).not.toContain(ids.users.editor2);
    expect(viewers.map((u) => u.id)).not.toContain(ids.users.photographer2);
    expect(viewers.some((u) => u.role === "client")).toBe(false);
    // The owner's mention list for the same job still names everyone who can see it, the past editor included.
    const forOwner = await getUserOptions(db, await ctxOf("owner"), { jobId: job.id, excludeSelf: "1" });
    expect(forOwner.map((u) => u.id)).toEqual(expect.arrayContaining([ids.users.photographer1, ids.users.editor1, ids.users.editor2]));
  });

  it("roster scope (plan §2, E17): editors get themselves, the owners and the photographers on their jobs; extra photographers add every editor; ⚑see all jobs and admins everyone", async () => {
    const staffOnly = (list: { role: string }[]) => list.every((u) => u.role !== "client");
    // Eve has no jobs yet: herself and the owner / co-owner only — never Ed, Leo or the other photographers.
    const empty = await getUserOptions(db, await ctxOf("editor1"));
    expect(empty.map((u) => u.id).sort()).toEqual([ids.users.coAdmin, ids.users.editor1, ids.users.owner].sort());
    expect(await getUserOptions(db, await ctxOf("editor1"), { role: "editor" })).toHaveLength(1);
    // A job shot by Pia (photographer1) and created by the owner: Pia appears; Ed, Leo and photographer2 still never.
    await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 });
    const withJob = await getUserOptions(db, await ctxOf("editor1"));
    expect(withJob.map((u) => u.id).sort()).toEqual([ids.users.coAdmin, ids.users.editor1, ids.users.owner, ids.users.photographer1].sort());
    expect(staffOnly(withJob)).toBe(true);
    // The job-create photographer picker is the one exception: an editor with "Can add their own jobs" must pick a shooter.
    expect((await getUserOptions(db, await ctxOf("editor1"), { role: "photographer" })).map((u) => u.id).sort()).toEqual(
      [ids.users.owner, ids.users.coAdmin, ids.users.lead, ids.users.photographer1, ids.users.photographer2].sort(),
    );
    await setUserFlags(db, ids.users.editor1, { canCreateJobs: false });
    expect((await getUserOptions(db, await ctxOf("editor1"), { role: "photographer" })).map((u) => u.id).sort()).toEqual([ids.users.coAdmin, ids.users.owner, ids.users.photographer1].sort());
    // Pia (extra photographer, no switches): every active editor (she assigns), herself, the owners, and the photographers on her jobs.
    const pia = await getUserOptions(db, await ctxOf("photographer1"));
    expect(pia.map((u) => u.id).sort()).toEqual([ids.users.coAdmin, ids.users.editor1, ids.users.editor2, ids.users.owner, ids.users.photographer1].sort());
    expect((await getUserOptions(db, await ctxOf("photographer1"), { role: "editor", includeInactive: "1" })).map((u) => u.id).sort()).toEqual(
      [ids.users.editor1, ids.users.editor2, ids.users.inactiveEditor].sort(),
    );
    expect((await getUserOptions(db, await ctxOf("photographer1"), { role: "photographer" })).map((u) => u.id)).not.toContain(ids.users.photographer2);
    // Leo (⚑see all jobs) and admins: the whole staff roster.
    expect((await getUserOptions(db, await ctxOf("lead"))).map((u) => u.id)).toEqual(expect.arrayContaining([ids.users.photographer2, ids.users.editor2, ids.users.lead]));
    expect((await getUserOptions(db, await ctxOf("owner"))).length).toBeGreaterThanOrEqual(8);
  });

  it("client picker: an extra photographer sees the clients on their jobs or that they created; admins every client", async () => {
    const pia = await ctxOf("photographer1");
    expect(await getClientOptions(db, pia)).toEqual([]);
    await insertJobFixture(db, ids, { statusKey: "assigned", editorId: ids.users.editor1 }); // client 1, shot by Pia
    expect((await getClientOptions(db, pia)).map((c) => c.id)).toEqual([ids.clientId]);
    await db.insert(clients).values({ id: "c-pia", organisationId: ids.organisationId, name: "Pia's Agency", createdByUserId: ids.users.photographer1, createdAt: NOW, updatedAt: NOW });
    expect((await getClientOptions(db, pia)).map((c) => c.id).sort()).toEqual(["c-pia", ids.clientId].sort());
    expect((await getClientOptions(db, await ctxOf("photographer2"))).map((c) => c.id)).toEqual([]);
    expect((await getClientOptions(db, await ctxOf("owner"))).map((c) => c.id).sort()).toEqual(["c-pia", ids.clientId, ids.clientId2].sort());
  });

  it("the Assign / Change editor picker (editorPickerOptions) is for photographers: editors and clients get 403 (E17)", async () => {
    expect((await editorPickerOptions(db, await ctxOf("photographer1"))).map((o) => o.editor.id).sort()).toEqual([ids.users.editor1, ids.users.editor2].sort());
    expect((await editorPickerOptions(db, await ctxOf("owner"))).length).toBe(2);
    await expect(editorPickerOptions(db, await ctxOf("editor1"))).rejects.toThrow(ForbiddenError);
    await expect(editorPickerOptions(db, await ctxOf("client"))).rejects.toThrow(ForbiddenError);
  });

  it("editor workloads only for viewers with team workloads; clients get 403", async () => {
    await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 });
    expect((await getUserOptions(db, await ctxOf("owner"), { role: "editor" })).find((u) => u.id === ids.users.editor1)?.workload?.active).toBe(1);
    expect((await getUserOptions(db, await ctxOf("photographer1"), { role: "editor" })).every((u) => u.workload === null)).toBe(true);
    await expect(getUserOptions(db, await ctxOf("client"))).rejects.toThrow(ForbiddenError);
    await expect(getUserOptions(db, await ctxOf("client"), { role: "photographer" })).rejects.toThrow(ForbiddenError);
  });
});
