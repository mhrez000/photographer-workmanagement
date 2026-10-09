import { describe, expect, it } from "vitest";
import { CreateClientInput } from "./clients";
import { UpdateSettingsInput } from "./settings";
import { DeactivateUserInput, InviteUserInput, SetNotificationPrefsInput } from "./users";
import { PutDashboardLayoutInput } from "./views";
import { AddStatusInput, AddTransitionInput, CreateWorkflowInput, StatusKeySchema } from "./workflow";
import { CalendarDateSchema, HexColourSchema } from "./admin-shared";

describe("admin validation schemas", () => {
  it("normalises optional text and emails", () => {
    expect(CreateClientInput.parse({ name: " A ", email: " X@Y.TEST ", phone: "  " })).toMatchObject({ name: "A", email: "x@y.test", phone: null });
    expect(CreateClientInput.safeParse({ name: "A", email: "nope" }).success).toBe(false);
    expect(HexColourSchema.parse("#AABBCC")).toBe("#aabbcc");
    expect(HexColourSchema.safeParse("red").success).toBe(false);
  });

  it("accepts civil dates and ISO instants only", () => {
    expect(CalendarDateSchema.parse("2026-10-10")).toBe("2026-10-10");
    expect(CalendarDateSchema.parse("2026-10-10T05:00:00.000Z")).toBe("2026-10-10T05:00:00.000Z");
    expect(CalendarDateSchema.safeParse("tomorrow").success).toBe(false);
  });

  it("users: roles, deactivation options, notification types", () => {
    expect(InviteUserInput.safeParse({ email: "a@b.test", name: "A", role: "admin" }).success).toBe(false);
    expect(DeactivateUserInput.safeParse({ userId: "u", reassignTo: "v", unassign: true }).success).toBe(false);
    expect(SetNotificationPrefsInput.safeParse({ prefs: { not_a_type: false } }).success).toBe(false);
    expect(SetNotificationPrefsInput.parse({ prefs: { comment_added: false } }).prefs).toEqual({ comment_added: false });
  });

  it("settings: strict keys, IANA time zones, prefix shape", () => {
    expect(UpdateSettingsInput.safeParse({ unknownKey: 1 }).success).toBe(false);
    expect(UpdateSettingsInput.safeParse({ timezone: "Nowhere/Land" }).success).toBe(false);
    expect(UpdateSettingsInput.parse({ timezone: "Europe/London", jobNumberPrefix: "ab1" })).toMatchObject({ jobNumberPrefix: "AB1" });
    expect(UpdateSettingsInput.safeParse({ jobNumberPrefix: "1AB" }).success).toBe(false);
  });

  it("workflow: slug keys, non-empty roles, no self-loops, copy needs a source", () => {
    expect(StatusKeySchema.safeParse("rough_cut").success).toBe(true);
    expect(StatusKeySchema.safeParse("Rough Cut").success).toBe(false);
    expect(AddStatusInput.safeParse({ workflowId: "w", name: "X", category: "nope" }).success).toBe(false);
    expect(AddTransitionInput.safeParse({ workflowId: "w", fromStatusId: "a", toStatusId: "a", allowedRoles: ["owner"] }).success).toBe(false);
    expect(AddTransitionInput.safeParse({ workflowId: "w", fromStatusId: "a", toStatusId: "b", allowedRoles: [] }).success).toBe(false);
    expect(CreateWorkflowInput.safeParse({ name: "X", from: "workflow" }).success).toBe(false);
    expect(CreateWorkflowInput.parse({ name: "X" }).from).toBe("default");
  });

  it("dashboard layout: unique widget ids and bounded geometry", () => {
    const widget = { id: "a", type: "kpis", x: 0, y: 0, w: 12, h: 2 };
    expect(PutDashboardLayoutInput.safeParse({ layout: { widgets: [widget] }, expectedVersion: 0 }).success).toBe(true);
    expect(PutDashboardLayoutInput.safeParse({ layout: { widgets: [widget, widget] } }).success).toBe(false);
    expect(PutDashboardLayoutInput.safeParse({ layout: { widgets: [{ ...widget, w: 0 }] } }).success).toBe(false);
  });
});
