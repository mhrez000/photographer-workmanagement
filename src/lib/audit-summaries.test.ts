import { describe, expect, it } from "vitest";
import { EVENT_TYPES } from "./constants";
import { describeEventForFeed, summarise } from "./audit-summaries";

describe("summarise", () => {
  it("handles every event type with empty payloads (actor-less, lowercase, no 'undefined')", () => {
    for (const type of EVENT_TYPES) {
      const s = summarise(type, null, null, {});
      expect(s, type).toMatch(/^[a-z]/);
      expect(s, type).not.toMatch(/undefined|null|\[object/);
    }
  });

  it("renders the canonical sentences", () => {
    expect(
      summarise("job.status_changed", { statusName: "Assigned", category: "assigned" }, { statusName: "In Progress", category: "in_progress" }, {}),
    ).toBe("changed status from Assigned to In Progress");
    expect(summarise("job.priority_changed", { priority: "normal" }, { priority: "urgent" }, {})).toBe("changed priority from Normal to Urgent");
    expect(summarise("job.due_date_changed", { value: "2026-10-12T12:59:59.999Z" }, { value: "2026-10-14T12:59:59.999Z" }, {})).toBe(
      "changed the due date from 12 Oct 2026 to 14 Oct 2026",
    );
    expect(summarise("job.review_due_date_changed", { value: null }, { value: "2026-10-09T12:59:59.999Z" }, { cause: "sla_default" })).toBe(
      "set the review deadline to 9 Oct 2026 (review SLA)",
    );
    expect(summarise("revision.requested", null, { revisionNumber: 2, reason: "Colour" }, {})).toBe("requested revision #2: Colour");
    expect(summarise("note.added", null, { kind: "internal", body: "x" }, {})).toBe("added an internal note");
    expect(summarise("link.replaced", null, null, { kind: "finished_files" })).toBe("replaced the finished files link");
    expect(summarise("user.role_changed", { role: "editor", name: "Eve" }, { role: "manager", name: "Eve" }, {})).toBe(
      "changed Eve’s role from Editor to Manager",
    );
    expect(summarise("user.password_changed", null, null, { self: true })).toBe("changed their password");
    expect(summarise("work_session.ended", null, { durationSeconds: 5400, endReason: "stopped" }, {})).toMatch(/^stopped the timer after/);
  });
});

describe("describeEventForFeed", () => {
  it("builds feed sentences", () => {
    expect(describeEventForFeed({ eventType: "job.completed", summary: "completed the job" }, "John", "123 Smith Street")).toBe(
      "John completed “123 Smith Street”",
    );
    expect(
      describeEventForFeed({ eventType: "job.status_changed", summary: "x", newValue: { statusName: "In Progress" }, automationRunId: "r1" }, null, "PJ-0001"),
    ).toBe("Automation moved “PJ-0001” to In Progress");
    expect(describeEventForFeed({ eventType: "job.became_overdue", summary: "x" }, null, "PJ-0002")).toBe("“PJ-0002” became overdue");
    expect(describeEventForFeed({ eventType: "comment.added", summary: "commented" }, "Sarah", "PJ-0003")).toBe("Sarah commented on “PJ-0003”");
    expect(describeEventForFeed({ eventType: "team.created", summary: "created team “Weddings”" }, "Olivia", null)).toBe(
      "Olivia created team “Weddings”",
    );
  });
});
