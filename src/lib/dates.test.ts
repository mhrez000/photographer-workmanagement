import { describe, expect, it } from "vitest";
import {
  addCivilDays,
  civilDate,
  civilDiffDays,
  civilMonthRange,
  civilWeekRange,
  daysRemaining,
  describeDue,
  endOfCivilDayIso,
  formatDate,
  formatDuration,
  formatRelative,
  isDueToday,
  isOverdue,
  resolveRange,
  startOfCivilDayIso,
  tzOffsetMs,
} from "./dates";

const TZ = "Australia/Sydney"; // UTC+11 in October (DST)
const NOW = new Date("2026-10-08T14:30:00Z"); // 09 Oct 01:30 in Sydney

describe("civil dates in timezone", () => {
  it("maps an instant to the studio's civil date", () => {
    expect(civilDate("2026-10-08T14:30:00Z", TZ)).toBe("2026-10-09");
    expect(civilDate("2026-10-08T12:59:00Z", TZ)).toBe("2026-10-08");
  });
  it("computes tz offset and day bounds", () => {
    expect(tzOffsetMs(NOW, TZ)).toBe(11 * 3_600_000);
    expect(startOfCivilDayIso("2026-10-09", TZ)).toBe("2026-10-08T13:00:00.000Z");
    expect(endOfCivilDayIso("2026-10-09", TZ)).toBe("2026-10-09T13:00:00.000Z");
    // Winter (no DST): UTC+10
    expect(startOfCivilDayIso("2026-06-15", TZ)).toBe("2026-06-14T14:00:00.000Z");
  });
  it("adds and diffs civil days across month ends", () => {
    expect(addCivilDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addCivilDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(civilDiffDays("2026-10-09", "2026-10-12")).toBe(3);
    expect(civilDiffDays("2026-10-09", "2026-10-07")).toBe(-2);
  });
  it("week starts Monday, month ranges are exclusive", () => {
    expect(civilWeekRange("2026-10-09")).toEqual(["2026-10-05", "2026-10-12"]); // Fri → Mon..next Mon
    expect(civilWeekRange("2026-10-11")).toEqual(["2026-10-05", "2026-10-12"]); // Sunday belongs to same week
    expect(civilMonthRange("2026-12-20")).toEqual(["2026-12-01", "2027-01-01"]);
  });
});

describe("due-date semantics", () => {
  it("judges today / overdue on the studio clock", () => {
    expect(daysRemaining("2026-10-09T03:00:00Z", TZ, NOW)).toBe(0);
    expect(isDueToday("2026-10-09T03:00:00Z", TZ, NOW)).toBe(true);
    expect(isOverdue("2026-10-09T03:00:00Z", TZ, NOW)).toBe(false);
    expect(isOverdue("2026-10-08T03:00:00Z", TZ, NOW)).toBe(true);
    expect(daysRemaining(null, TZ, NOW)).toBeNull();
  });
  it("describes due state", () => {
    expect(describeDue("2026-10-06T03:00:00Z", TZ, NOW)).toEqual({ label: "Overdue by 3d", tone: "overdue" });
    expect(describeDue("2026-10-10T03:00:00Z", TZ, NOW)).toEqual({ label: "Due tomorrow", tone: "soon" });
    expect(describeDue(undefined, TZ, NOW).tone).toBe("none");
  });
});

describe("ranges and formatting", () => {
  it("resolves presets", () => {
    const week = resolveRange("this_week", TZ, undefined, NOW);
    expect(week.from).toBe("2026-10-04T13:00:00.000Z");
    expect(week.to).toBe("2026-10-11T13:00:00.000Z");
    const lastMonth = resolveRange("last_month", TZ, undefined, NOW);
    expect(lastMonth.from).toBe(startOfCivilDayIso("2026-09-01", TZ));
    expect(lastMonth.to).toBe(startOfCivilDayIso("2026-10-01", TZ));
    const custom = resolveRange("custom", TZ, { from: "2026-01-01", to: "2026-01-31" }, NOW);
    expect(custom.to).toBe(startOfCivilDayIso("2026-02-01", TZ));
  });
  it("formats", () => {
    expect(formatDate("2026-09-14", TZ)).toBe("14 Sept 2026");
    expect(formatDate("2026-09-14T13:00:00Z", TZ)).toBe("14 Sept 2026");
    expect(formatDuration(2 * 86_400_000 + 4 * 3_600_000)).toBe("2d 4h");
    expect(formatDuration(65 * 60_000)).toBe("1h 05m");
    expect(formatDuration(30_000)).toBe("<1m");
    expect(formatRelative("2026-10-08T11:30:00Z", NOW)).toBe("3h ago");
    expect(formatRelative("2026-10-10T14:30:00Z", NOW)).toBe("in 2d");
  });
});
