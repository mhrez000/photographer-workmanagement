import { describe, expect, it } from "vitest";
import { JOB_FILTER_KEYS, JOB_SCOPE_KEYS, scopeChips } from "./quick-filters";

const TZ = "Australia/Sydney";
const getter = (q: Record<string, string>) => (k: string) => q[k] ?? null;

describe("drill-down scope chips", () => {
  it("every drill-down key is cleared by Clear all", () => {
    for (const k of JOB_SCOPE_KEYS) expect(JOB_FILTER_KEYS).toContain(k);
  });

  it("labels the Completed-this-week drill-down with the inclusive civil range", () => {
    // [Mon 5 Oct 00:00, Mon 12 Oct 00:00) Sydney = 4 Oct 13:00Z … 11 Oct 13:00Z.
    const chips = scopeChips(getter({ completedFrom: "2026-10-04T13:00:00.000Z", completedTo: "2026-10-11T13:00:00.000Z" }), TZ);
    expect(chips).toEqual([{ id: "completed", label: "Completed 5 Oct 2026 – 11 Oct 2026", keys: ["completedFrom", "completedTo"] }]);
  });

  it("labels the revision-spike and review-bottleneck drill-downs", () => {
    const chips = scopeChips(getter({ revisedFrom: "2026-10-02T09:30:00.000Z", includeCancelled: "1", statusEnteredBefore: "2026-10-08T09:30:00.000Z" }), TZ);
    expect(chips.map((c) => c.label)).toEqual([
      "Revision requested since 2 Oct 2026",
      "In this status since before 8 Oct 2026, 8:30 pm",
      "Including cancelled",
    ]);
    expect(chips.find((c) => c.id === "includeCancelled")?.keys).toEqual(["includeCancelled"]);
  });

  it("ignores absent and empty params", () => {
    expect(scopeChips(getter({ q: "smith", completedFrom: "", includeCancelled: "0" }), TZ)).toEqual([]);
  });
});
