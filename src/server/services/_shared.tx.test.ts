/** withTx / afterCommit / savepoint semantics on Postgres (PGlite). */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clients } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { isUniqueViolation } from "@/db/errors";
import { setDbOverride } from "@/db/index";
import { afterCommit, first, one, withTx } from "./_shared";
import { notify, registerNotificationChannel, type NotificationChannel } from "./notifications";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("withTx", () => {
  it("commits, returns the result, and runs afterCommit hooks only after COMMIT", async () => {
    const seen: string[] = [];
    const result = await withTx(async (tx) => {
      await tx.update(clients).set({ name: "Renamed" }).where(eq(clients.id, ids.clientId));
      afterCommit(tx, () => {
        seen.push("hook");
      });
      seen.push("body");
      return 42;
    }, { db });
    expect(result).toBe(42);
    expect(seen).toEqual(["body", "hook"]);
    expect((await one(db.select().from(clients).where(eq(clients.id, ids.clientId)))).name).toBe("Renamed");
  });

  it("rolls back on throw and drops afterCommit hooks", async () => {
    const seen: string[] = [];
    await expect(
      withTx(async (tx) => {
        await tx.update(clients).set({ name: "Nope" }).where(eq(clients.id, ids.clientId));
        afterCommit(tx, () => {
          seen.push("hook");
        });
        throw new Error("boom");
      }, { db }),
    ).rejects.toThrow("boom");
    await flush();
    expect(seen).toEqual([]);
    expect((await first(db.select().from(clients).where(eq(clients.id, ids.clientId))))?.name).toBe("Harbour Realty");
  });

  it("a savepoint (tx.transaction) lets a caught DB error keep the outer transaction alive", async () => {
    await withTx(async (tx) => {
      try {
        await tx.transaction(async (sp) => {
          // primary-key clash
          await sp.insert(clients).values({ id: ids.clientId, organisationId: ids.organisationId, name: "dupe" });
        });
      } catch (err) {
        expect(isUniqueViolation(err)).toBe(true);
      }
      await tx.update(clients).set({ name: "After savepoint" }).where(eq(clients.id, ids.clientId));
    }, { db });
    expect((await one(db.select().from(clients).where(eq(clients.id, ids.clientId)))).name).toBe("After savepoint");
  });

  it("external notification channels receive rows only after commit", async () => {
    const delivered: string[] = [];
    const channel: NotificationChannel = {
      id: "test-channel",
      deliver: async (n) => {
        delivered.push(n.title);
      },
    };
    const unregister = registerNotificationChannel(channel);
    // the post-commit dispatcher reads through getDb(); point it at the test db
    setDbOverride(db);
    try {
      const ctx = await contextFor(db, ids.users.coAdmin);
      await expect(
        withTx(async (tx) => {
          await notify(tx, ctx, { userIds: [ids.users.editor1], type: "comment_added", title: "rolled back", linkPath: "/" });
          throw new Error("rollback");
        }, { db }),
      ).rejects.toThrow("rollback");
      await withTx((tx) => notify(tx, ctx, { userIds: [ids.users.editor1], type: "comment_added", title: "committed", linkPath: "/" }), {
        db,
      });
      for (let i = 0; i < 5 && delivered.length === 0; i += 1) await flush();
    } finally {
      unregister();
    }
    expect(delivered).toEqual(["committed"]);
  });
});
