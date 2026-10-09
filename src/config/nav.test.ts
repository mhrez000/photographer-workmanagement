import { describe, expect, it } from "vitest";
import { navigationForRole, resolveRouteTitle } from "./nav";

describe("resolveRouteTitle (topbar title)", () => {
  const manager = navigationForRole("manager");
  const editor = navigationForRole("editor");

  it("uses the nav item + group for sidebar routes", () => {
    expect(resolveRouteTitle("/dashboard", manager)?.title).toBe("Dashboard");
    expect(resolveRouteTitle("/workspace/kanban", manager)?.title).toBe("Kanban");
    expect(resolveRouteTitle("/team/workloads", manager)).toMatchObject({ eyebrow: "Team" });
  });

  it("names the personal pages reached from the bell, search and user menu", () => {
    for (const groups of [manager, editor]) {
      expect(resolveRouteTitle("/notifications", groups)?.title).toBe("Notifications");
      expect(resolveRouteTitle("/search", groups)?.title).toBe("Search");
      expect(resolveRouteTitle("/settings/profile", groups)?.title).toBe("Your profile");
      expect(resolveRouteTitle("/settings/appearance", groups)?.title).toBe("Appearance");
      expect(resolveRouteTitle("/help", groups)?.title).toBe("Help & shortcuts");
    }
  });

  it("falls back to the user-menu label when no visible nav item matches", () => {
    expect(resolveRouteTitle("/settings/notifications", [])?.title).toBe("Notification settings");
    expect(resolveRouteTitle("/settings/notifications", editor)?.title).toBeTruthy();
  });

  it("titles the dynamic team member page", () => {
    expect(resolveRouteTitle("/team/users/abc123", manager)).toEqual({ title: "Team member", eyebrow: "Team" });
    expect(resolveRouteTitle("/team/users/abc123/history", manager)?.title).toBe("Team member");
  });

  it("does not over-match look-alike paths", () => {
    expect(resolveRouteTitle("/searchable", editor)).toBeNull();
    expect(resolveRouteTitle("/team/users", editor)).toBeNull();
  });
});
