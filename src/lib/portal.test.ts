import { describe, expect, it } from "vitest";
import { STATUS_CATEGORIES, type StatusCategory } from "@/lib/constants";
import { clientMilestone, comparePortalJobs, isSafeExternalUrl, milestoneSteps, portalDay } from "@/lib/portal";
import type { PortalJob } from "@/lib/types";

const TZ = "Australia/Sydney";
// 2026-10-11 13:00 in Sydney (AEDT, UTC+11).
const NOW = "2026-10-11T02:00:00.000Z";

const base = { shootDate: null, everDelivered: false } as const;

describe("clientMilestone (docs/ROLES.md §7.4)", () => {
  it("cancelled → no milestone, 'Cancelled' with the studio's date", () => {
    const m = clientMilestone({ ...base, category: "cancelled", cancelledAt: "2026-10-01T03:00:00.000Z", everDelivered: true }, NOW, TZ);
    expect(m).toEqual({ milestone: null, label: "Cancelled", detail: "Cancelled by the studio on 1 Oct", updating: false, cancelled: true });
  });

  it("delivered / completed → Delivered with the latest delivery day", () => {
    for (const category of ["delivered", "completed"] as const) {
      const m = clientMilestone({ ...base, category, everDelivered: true, deliveredAt: "2026-10-08T01:00:00.000Z" }, NOW, TZ);
      expect(m).toMatchObject({ milestone: "delivered", label: "Delivered", detail: "Delivered 8 Oct", updating: false, cancelled: false });
    }
  });

  it("reopened after delivery → Delivered + updating ('Updating your delivery')", () => {
    for (const category of ["revision", "in_progress", "review", "ready"] as const) {
      const m = clientMilestone({ ...base, category, everDelivered: true }, NOW, TZ);
      expect(m).toEqual({
        milestone: "delivered",
        label: "Updating your delivery",
        detail: "Your delivered files stay available",
        updating: true,
        cancelled: false,
      });
    }
  });

  it("pre-editing without a shoot date → Booked, no detail", () => {
    for (const category of ["new", "ready", "assigned", "accepted"] as const) {
      expect(clientMilestone({ ...base, category }, NOW, TZ)).toEqual({ milestone: "booked", label: "Booked", detail: null, updating: false, cancelled: false });
    }
  });

  it("future shoot → Booked 'Shoot scheduled for …'", () => {
    const m = clientMilestone({ ...base, category: "assigned", shootDate: "2026-10-14T00:00:00.000Z" }, NOW, TZ);
    expect(m).toMatchObject({ milestone: "booked", detail: "Shoot scheduled for 14 Oct" });
  });

  it("shoot today → Booked 'Shoot today'", () => {
    const m = clientMilestone({ ...base, category: "new", shootDate: "2026-10-11T05:00:00.000Z" }, NOW, TZ);
    expect(m).toMatchObject({ milestone: "booked", label: "Booked", detail: "Shoot today" });
  });

  it("past shoot before editing starts → Shot", () => {
    const m = clientMilestone({ ...base, category: "accepted", shootDate: "2026-10-09T00:00:00.000Z" }, NOW, TZ);
    expect(m).toEqual({ milestone: "shot", label: "Shot", detail: null, updating: false, cancelled: false });
  });

  it("compares calendar days in the org timezone, not UTC", () => {
    // 23:30 UTC on the 10th is 10:30 on the 11th in Sydney: the shoot is TODAY there (UTC would say "yesterday" → Shot).
    expect(clientMilestone({ ...base, category: "ready", shootDate: "2026-10-10T23:30:00.000Z" }, NOW, TZ)).toMatchObject({
      milestone: "booked",
      detail: "Shoot today",
    });
    // 23:30 UTC on the 11th is the 12th in Sydney: still in the future.
    expect(clientMilestone({ ...base, category: "ready", shootDate: "2026-10-11T23:30:00.000Z" }, NOW, TZ)).toMatchObject({
      milestone: "booked",
      detail: "Shoot scheduled for 12 Oct",
    });
    // In UTC the same instants fall on other days.
    expect(clientMilestone({ ...base, category: "ready", shootDate: "2026-10-10T23:30:00.000Z" }, NOW, "UTC")).toMatchObject({ milestone: "shot" });
  });

  it("editing categories → Editing", () => {
    for (const category of ["in_progress", "submitted", "review", "revision", "resubmitted", "approved"] as const) {
      expect(clientMilestone({ ...base, category, shootDate: "2026-10-01T00:00:00.000Z" }, NOW, TZ)).toEqual({
        milestone: "editing",
        label: "Editing",
        detail: null,
        updating: false,
        cancelled: false,
      });
    }
  });

  it("maps every status category to a milestone or cancelled", () => {
    for (const category of STATUS_CATEGORIES as readonly StatusCategory[]) {
      const m = clientMilestone({ ...base, category }, NOW, TZ);
      expect(m.cancelled).toBe(category === "cancelled");
      expect(m.milestone === null).toBe(category === "cancelled");
    }
  });
});

function job(overrides: Partial<PortalJob>): PortalJob {
  return {
    id: "j",
    jobNumber: "PJ-0001",
    name: "Job",
    project: { id: "p", name: "Project", address: null },
    jobTypeName: "Photography",
    milestone: "booked",
    milestoneLabel: "Booked",
    milestoneDetail: null,
    updating: false,
    cancelled: false,
    shootDate: null,
    deliveryDueDate: null,
    deliveredAt: null,
    cancelledAt: null,
    photographer: null,
    ...overrides,
  };
}

describe("milestoneSteps", () => {
  it("marks earlier steps done and the current step current", () => {
    const steps = milestoneSteps(job({ milestone: "editing", shootDate: "2026-10-01T00:00:00.000Z" }));
    expect(steps.map((s) => [s.key, s.state])).toEqual([
      ["booked", "done"],
      ["shot", "done"],
      ["editing", "current"],
      ["delivered", "upcoming"],
    ]);
    expect(steps[1]?.date).toBe("2026-10-01T00:00:00.000Z");
  });

  it("delivered is fully done; updating keeps Delivered current", () => {
    expect(milestoneSteps(job({ milestone: "delivered", deliveredAt: "2026-10-08T00:00:00.000Z" })).every((s) => s.state === "done")).toBe(true);
    const updating = milestoneSteps(job({ milestone: "delivered", updating: true }));
    expect(updating[3]).toMatchObject({ key: "delivered", state: "current" });
  });

  it("delivered step shows the delivery date, else the agreed delivery date", () => {
    expect(milestoneSteps(job({ milestone: "booked", deliveryDueDate: "2026-10-20T12:59:59.000Z" }))[3]?.date).toBe("2026-10-20T12:59:59.000Z");
    expect(milestoneSteps(job({ milestone: "delivered", deliveredAt: "2026-10-18T00:00:00.000Z", deliveryDueDate: "2026-10-20T00:00:00.000Z" }))[3]?.date).toBe(
      "2026-10-18T00:00:00.000Z",
    );
  });

  it("cancelled jobs have no stepper", () => {
    expect(milestoneSteps(job({ milestone: null, cancelled: true }))).toEqual([]);
  });
});

describe("comparePortalJobs", () => {
  const a = job({ id: "a", jobNumber: "PJ-1", milestone: "delivered", deliveredAt: "2026-10-01T00:00:00.000Z" });
  const b = job({ id: "b", jobNumber: "PJ-2", milestone: "editing" });
  const c = job({ id: "c", jobNumber: "PJ-3", milestone: null, cancelled: true });
  const d = job({ id: "d", jobNumber: "PJ-4", milestone: "booked" });
  const e = job({ id: "e", jobNumber: "PJ-5", milestone: "delivered", deliveredAt: "2026-10-05T00:00:00.000Z" });

  it("progress: in flight first, delivered newest first, cancelled last", () => {
    expect([a, b, c, d, e].sort(comparePortalJobs("progress")).map((j) => j.id)).toEqual(["b", "d", "e", "a", "c"]);
  });

  it("delivered: delivered first (newest first), then progress order, cancelled last", () => {
    expect([a, b, c, d, e].sort(comparePortalJobs("delivered")).map((j) => j.id)).toEqual(["e", "a", "b", "d", "c"]);
  });
});

describe("helpers", () => {
  it("isSafeExternalUrl accepts only http(s)", () => {
    expect(isSafeExternalUrl("https://example.com/a")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(true);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("data:text/html,hi")).toBe(false);
    expect(isSafeExternalUrl("not a url")).toBe(false);
  });

  it("portalDay formats in the org timezone", () => {
    expect(portalDay("2026-10-10T23:30:00.000Z", TZ)).toBe("11 Oct");
    expect(portalDay(null, TZ)).toBeNull();
  });
});
