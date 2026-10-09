import { describe, expect, it } from "vitest";
import type { StatusCategory } from "@/lib/constants";
import type { CalendarEvent, StatusRef } from "@/lib/types";
import { legendFor } from "./calendar-utils";

const status = (id: string, name: string, colour: string, sortOrder: number, category: StatusCategory = "in_progress"): StatusRef => ({ id, key: id, name, category, colour, sortOrder });

const event = (id: string, s: StatusRef, editor: { id: string; name: string } | null = null): CalendarEvent => ({
  id,
  kind: "due",
  at: "2026-10-08T12:59:59.999Z",
  isOverdue: false,
  job: {
    id: `job-${id}`,
    jobNumber: `PJ-00${id}`,
    name: `Job ${id}`,
    priority: "normal",
    statusCategory: s.category,
    status: s,
    editor: editor ? { ...editor, avatarColour: "#123456" } : null,
    photographer: null,
  } as CalendarEvent["job"],
});

const dayOf = () => "2026-10-08";

describe("legendFor", () => {
  it("lists a status name once even when several workflows use it, with one swatch per colour", () => {
    const photo = status("s1", "In Progress", "#3b82f6", 3);
    const video = status("s2", "In Progress", "#6366f1", 4);
    const ready = status("s3", "Ready for Assignment", "#0ea5e9", 1, "ready");
    const readyVideo = status("s4", "Ready for Assignment", "#0ea5e9", 1, "ready");
    const submitted = status("s5", "Submitted for Review", "#f59e0b", 5, "submitted");
    const events = [event("1", photo), event("2", video), event("3", ready), event("4", readyVideo), event("5", submitted), event("6", photo)];

    const legend = legendFor(events, "status", dayOf, "2026-10-08");
    const labels = legend.map((l) => l.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(["Ready for Assignment", "In Progress", "Submitted for Review"]);
    expect(legend.find((l) => l.label === "In Progress")?.colours).toEqual(["#3b82f6", "#6366f1"]);
    expect(legend.find((l) => l.label === "Ready for Assignment")?.colours).toEqual(["#0ea5e9"]);
  });

  it("keeps editor entries per person and fixed lists for priority / overdue modes", () => {
    const s = status("s1", "In Progress", "#3b82f6", 3);
    const editors = legendFor([event("1", s, { id: "u1", name: "Ava" }), event("2", s, { id: "u1", name: "Ava" }), event("3", s)], "editor", dayOf, "2026-10-08");
    expect(editors.map((l) => l.label)).toEqual(["Ava", "Unassigned"]);
    expect(legendFor([], "priority", dayOf, "2026-10-08").every((l) => l.colours.length === 1)).toBe(true);
    expect(legendFor([], "overdue", dayOf, "2026-10-08").map((l) => l.label)).toEqual(["Overdue", "Due today", "Upcoming", "Done"]);
  });
});
