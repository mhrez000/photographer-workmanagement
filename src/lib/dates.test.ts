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
    expect(endOfCivilDayIso("2026-10-09", TZ)).toBe("2026-10-09T12:59:59.999Z");
    expect(civilDate(endOfCivilDayIso("2026-10-09", TZ), TZ)).toBe("2026-10-09");
    expect(daysRemaining(endOfCivilDayIso("2026-10-09", TZ), TZ, NOW)).toBe(0);
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

describe("day bounds across DST changes (Sydney)", () => {
  const days = ["2026-10-03", "2026-10-04", "2027-04-03", "2027-04-04"];
  it.each(days)("start and end of %s fall on that civil day", (d) => {
    expect(civilDate(startOfCivilDayIso(d, TZ), TZ)).toBe(d);
    expect(civilDate(endOfCivilDayIso(d, TZ), TZ)).toBe(d);
    // end of day + 1 ms is the start of the next day
    expect(new Date(Date.parse(endOfCivilDayIso(d, TZ)) + 1).toISOString()).toBe(startOfCivilDayIso(addCivilDays(d, 1), TZ));
  });
  it("uses the offset in force at local midnight", () => {
    // Sat 3 Oct 2026 is AEST (+10) all day; DST starts at 02:00 on Sun 4 Oct.
    expect(endOfCivilDayIso("2026-10-03", TZ)).toBe("2026-10-03T13:59:59.999Z");
    expect(startOfCivilDayIso("2026-10-04", TZ)).toBe("2026-10-03T14:00:00.000Z");
    // Sun 4 Apr 2027 starts in AEDT (+11); DST ends at 03:00.
    expect(startOfCivilDayIso("2027-04-04", TZ)).toBe("2027-04-03T13:00:00.000Z");
    expect(endOfCivilDayIso("2027-04-03", TZ)).toBe("2027-04-03T12:59:59.999Z");
  });
});

describe("day bounds when local midnight does not exist", () => {
  it("starts the day at the DST transition (America/Santiago, America/Havana)", () => {
    // Santiago jumps 00:00 → 01:00 on Sun 6 Sep 2026 (−04 → −03).
    expect(startOfCivilDayIso("2026-09-06", "America/Santiago")).toBe("2026-09-06T04:00:00.000Z");
    expect(endOfCivilDayIso("2026-09-05", "America/Santiago")).toBe("2026-09-06T03:59:59.999Z");
    // Havana jumps 00:00 → 01:00 on Sun 8 Mar 2026 (−05 → −04).
    expect(startOfCivilDayIso("2026-03-08", "America/Havana")).toBe("2026-03-08T05:00:00.000Z");
    expect(endOfCivilDayIso("2026-03-07", "America/Havana")).toBe("2026-03-08T04:59:59.999Z");
  });

  const ZONES = [
    "Australia/Sydney",
    "Australia/Lord_Howe",
    "Pacific/Auckland",
    "Pacific/Chatham",
    "America/Santiago",
    "America/Havana",
    "America/Asuncion",
    "America/New_York",
    "Europe/London",
    "Asia/Tehran",
    "UTC",
  ];
  it.each(ZONES)("every day of 2026–2027 in %s starts on that day and ends where the next begins", (zone) => {
    let day = "2026-01-01";
    for (let i = 0; i < 730; i += 1) {
      const start = startOfCivilDayIso(day, zone);
      const end = endOfCivilDayIso(day, zone);
      expect(civilDate(start, zone), `${zone} start ${day}`).toBe(day);
      expect(civilDate(new Date(Date.parse(start) - 1), zone), `${zone} start-1ms ${day}`).toBe(addCivilDays(day, -1));
      expect(civilDate(end, zone), `${zone} end ${day}`).toBe(day);
      expect(new Date(Date.parse(end) + 1).toISOString(), `${zone} end+1ms ${day}`).toBe(startOfCivilDayIso(addCivilDays(day, 1), zone));
      day = addCivilDays(day, 1);
    }
  });
});

describe("week start", () => {
  it("civilWeekRange honours weekStartsOn", () => {
    expect(civilWeekRange("2026-10-08")).toEqual(["2026-10-05", "2026-10-12"]); // Thu → Mon
    expect(civilWeekRange("2026-10-08", 0)).toEqual(["2026-10-04", "2026-10-11"]); // Thu → Sun
    expect(civilWeekRange("2026-10-04", 0)).toEqual(["2026-10-04", "2026-10-11"]); // Sun stays
    expect(civilWeekRange("2026-10-04", 1)).toEqual(["2026-09-28", "2026-10-05"]);
    expect(civilWeekRange("2026-10-08", 6)).toEqual(["2026-10-03", "2026-10-10"]); // Sat
  });
  it("this_week starts on Sunday with weekStartsOn = 0", () => {
    const week = resolveRange("this_week", TZ, undefined, NOW, { weekStartsOn: 0 }); // now = Fri 9 Oct (Sydney)
    expect(civilDate(week.from, TZ)).toBe("2026-10-04");
    expect(new Date(Date.parse(week.from)).getUTCDay()).toBe(6); // Sun 00:00 AEDT = Sat 13:00Z
    expect(week.from).toBe(startOfCivilDayIso("2026-10-04", TZ));
    expect(week.to).toBe(startOfCivilDayIso("2026-10-11", TZ));
  });
});
