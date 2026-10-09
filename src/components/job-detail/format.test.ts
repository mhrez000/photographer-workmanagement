import { describe, expect, it } from "vitest";
import { describeDue } from "@/lib/dates";
import { durationSeconds, editingSeconds, timeInStage, type TransitionLike } from "@/lib/metrics";
import type { LinkSlot, LinkView } from "@/lib/types";
import { displayUrlParts, fitTabs, showsDaysRemaining, slotKind, stageOf, stageTotalsFromCategories, stageTotalsFromStages, STAGES } from "./format";

/* ------------------------------------------------------------------ */
/*  Stage totals: Overview stepper, Timeline lanes and facts rail agree */
/* ------------------------------------------------------------------ */

const NOW = "2026-10-09T00:00:00.000Z";

/** A job that waited in New, was assigned, edited, reviewed, revised twice (with a re-attribution) and approved. */
const TRANSITIONS: TransitionLike[] = [
  { sequence: 1, kind: "creation", toCategory: "new", enteredAt: "2026-09-01T00:00:00.000Z", exitedAt: "2026-09-01T03:27:00.000Z", editorIdAtEntry: null },
  { sequence: 2, kind: "transition", toCategory: "assigned", enteredAt: "2026-09-01T03:27:00.000Z", exitedAt: "2026-09-01T10:50:00.000Z", editorIdAtEntry: "e1" },
  { sequence: 3, kind: "transition", toCategory: "in_progress", enteredAt: "2026-09-01T10:50:00.000Z", exitedAt: "2026-09-01T23:07:00.000Z", editorIdAtEntry: "e1" },
  { sequence: 4, kind: "transition", toCategory: "submitted", enteredAt: "2026-09-01T23:07:00.000Z", exitedAt: "2026-09-02T05:00:00.000Z", editorIdAtEntry: "e1" },
  { sequence: 5, kind: "transition", toCategory: "review", enteredAt: "2026-09-02T05:00:00.000Z", exitedAt: "2026-09-03T00:00:00.000Z", editorIdAtEntry: "e1" },
  { sequence: 6, kind: "transition", toCategory: "revision", enteredAt: "2026-09-03T00:00:00.000Z", exitedAt: "2026-09-04T12:00:00.000Z", editorIdAtEntry: "e1" },
  { sequence: 7, kind: "reattribution", toCategory: "revision", enteredAt: "2026-09-04T12:00:00.000Z", exitedAt: "2026-09-06T00:00:00.000Z", editorIdAtEntry: "e2" },
  { sequence: 8, kind: "transition", toCategory: "resubmitted", enteredAt: "2026-09-06T00:00:00.000Z", exitedAt: "2026-09-06T08:00:00.000Z", editorIdAtEntry: "e2" },
  { sequence: 9, kind: "transition", toCategory: "approved", enteredAt: "2026-09-06T08:00:00.000Z", exitedAt: null, editorIdAtEntry: "e2" },
];

/** What toStageViews() gives the Timeline tab: one row per transition, open row up to now. */
const stageRows = TRANSITIONS.map((t) => ({ toCategory: t.toCategory, durationSeconds: durationSeconds(t.enteredAt, t.exitedAt, NOW) }));

describe("stage totals", () => {
  it("Overview (secondsPerCategory) and Timeline (stage rows) give identical per-stage totals", () => {
    const overview = stageTotalsFromCategories(timeInStage(TRANSITIONS, NOW));
    const timeline = stageTotalsFromStages(stageRows);
    expect(overview).toEqual(timeline);
    expect(Object.keys(overview)).toEqual([...STAGES]);
  });

  it("counts New toward Assignment and keeps Editing and Revision separate", () => {
    const totals = stageTotalsFromStages(stageRows);
    expect(totals.assignment).toBe((3 * 60 + 27) * 60 + (7 * 60 + 23) * 60); // New 3h27m + Assigned 7h23m
    expect(totals.editing).toBe((12 * 60 + 17) * 60); // in_progress only
    expect(totals.revision).toBe(3 * 86_400); // both revision rows (incl. the re-attribution split)
    expect(totals.review).toBe((5 * 60 + 53) * 60 + 19 * 3600 + 8 * 3600); // submitted + review + resubmitted
    expect(stageOf("new")).toBe("assignment");
    expect(stageOf("revision")).toBe("revision");
    expect(stageOf("cancelled")).toBeNull();
  });

  it("the facts rail's Editing + Revision equal the editing ledger metric (no time lost or double counted)", () => {
    const totals = stageTotalsFromCategories(timeInStage(TRANSITIONS, NOW));
    expect(totals.editing + totals.revision).toBe(editingSeconds(TRANSITIONS, NOW));
  });

  it("every second of the job lands in exactly one stage", () => {
    const totals = stageTotalsFromStages(stageRows);
    const sum = Object.values(totals).reduce((a, b) => a + b, 0);
    expect(sum).toBe(stageRows.reduce((a, r) => a + r.durationSeconds, 0));
  });
});

/* ------------------------------------------------------------------ */
/*  Tab bar overflow                                                    */
/* ------------------------------------------------------------------ */

describe("fitTabs", () => {
  const widths = [100, 80, 80, 100, 100, 90, 90, 80, 70]; // 790

  it("keeps every tab when they fit", () => {
    expect(fitTabs(widths, 800, 90, 0)).toEqual({ visible: [0, 1, 2, 3, 4, 5, 6, 7, 8], overflow: [] });
  });

  it("moves trailing tabs into More, leaving room for the More button", () => {
    const { visible, overflow } = fitTabs(widths, 560, 90, 0);
    expect(visible).toEqual([0, 1, 2, 3, 4]); // 460 ≤ 470
    expect(overflow).toEqual([5, 6, 7, 8]);
    expect([...visible, ...overflow].sort()).toEqual(widths.map((_, i) => i));
  });

  it("always keeps the active tab in the bar, in order", () => {
    const { visible, overflow } = fitTabs(widths, 560, 90, 7); // History active
    expect(visible).toContain(7);
    expect(visible).toEqual([...visible].sort((a, b) => a - b));
    expect(visible.reduce((s, i) => s + widths[i], 0)).toBeLessThanOrEqual(560 - 90);
    expect(overflow).not.toContain(7);
  });

  it("shows at least the active tab on a tiny bar", () => {
    expect(fitTabs(widths, 120, 90, 3).visible).toEqual([3]);
  });
});

/* ------------------------------------------------------------------ */
/*  Header due indicator                                                */
/* ------------------------------------------------------------------ */

describe("showsDaysRemaining", () => {
  const tz = "Australia/Sydney";
  const now = new Date("2026-10-09T02:00:00.000Z");
  it("never adds text next to a chip that already says overdue / today / soon", () => {
    for (const due of ["2026-10-02T12:59:59.999Z", "2026-10-09T12:59:59.999Z", "2026-10-10T12:59:59.999Z", "2026-10-11T12:59:59.999Z"]) {
      expect(showsDaysRemaining(describeDue(due, tz, now).tone)).toBe(false);
    }
  });
  it("adds days left only next to a plain date", () => {
    expect(showsDaysRemaining(describeDue("2026-10-20T12:59:59.999Z", tz, now).tone)).toBe(true);
    expect(showsDaysRemaining(describeDue(null, tz, now).tone)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Link URL display                                                    */
/* ------------------------------------------------------------------ */

describe("displayUrlParts", () => {
  it("shows host + path, keeping the last segment out of the ellipsis", () => {
    expect(displayUrlParts("https://www.dropbox.com/sh/uxqa-raw-2")).toEqual({ head: "dropbox.com/sh/", tail: "uxqa-raw-2" });
  });
  it("drops query, hash and trailing slashes", () => {
    expect(displayUrlParts("https://drive.google.com/drive/folders/abc/?usp=sharing#x")).toEqual({ head: "drive.google.com/drive/folders/", tail: "abc" });
  });
  it("host-only links have no tail", () => {
    expect(displayUrlParts("https://frame.io/")).toEqual({ head: "frame.io", tail: "" });
  });
  it("caps a long last segment so the head still carries the middle ellipsis", () => {
    const parts = displayUrlParts("https://x.com/a/0123456789012345678901234567890123456789");
    expect(parts?.tail).toHaveLength(20);
    expect(`${parts?.head}${parts?.tail}`).toBe("x.com/a/0123456789012345678901234567890123456789");
  });
  it("decodes the path and rejects unparseable input", () => {
    expect(displayUrlParts("https://example.com/Final%20gallery")?.tail).toBe("Final gallery");
    expect(displayUrlParts("not a url")).toBeNull();
  });
});

describe("slotKind", () => {
  const view = (id: string, kind: LinkView["kind"], isCurrent: boolean) => ({ id, kind, isCurrent }) as LinkView;
  it("files a re-filed chain under its latest row, not the chain root", () => {
    const moved: LinkSlot = { kind: "raw_files", current: view("b", "reference", true), history: [view("a", "raw_files", false), view("b", "reference", true)] };
    expect(slotKind(moved)).toBe("reference");
  });
  it("uses the last history row for a removed chain and falls back to the slot kind", () => {
    expect(slotKind({ kind: "raw_files", current: null, history: [view("a", "raw_files", false), view("b", "gallery", false)] })).toBe("gallery");
    expect(slotKind({ kind: "other", current: null, history: [] })).toBe("other");
  });
});
