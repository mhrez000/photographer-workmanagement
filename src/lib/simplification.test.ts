/**
 * Registries added for docs/SIMPLIFICATION-PLAN.md: the Advanced-tools feature list (every hidden route
 * and API prefix is claimed exactly once), the 8 default notification groups, photographer presets
 * (decision 4), the silent-project key, rush priority and the late-summary dedupe key.
 */
import { describe, expect, it } from "vitest";
import {
  ADVANCED_FEATURE_META,
  ADVANCED_FEATURES,
  ADVANCED_JOB_SUBPATHS,
  CLIENT_NOTIFICATION_TYPES,
  DEFAULT_OFF_NOTIFICATION_TYPES,
  DEFAULT_ON_NOTIFICATION_TYPES,
  DEMO_ACCOUNTS,
  isRushPriority,
  lateSummaryDedupeKey,
  MEMBER_FLAGS,
  NOTIFICATION_GROUPS,
  NOTIFICATION_TYPE_META,
  NOTIFICATION_TYPES,
  normaliseProjectKey,
  notificationTypesOfGroup,
  PHOTOGRAPHER_PRESET_META,
  PHOTOGRAPHER_PRESETS,
  photographerPresetOf,
  presetSwitches,
  priorityForRush,
  SIMPLE_REOPEN_REASON_LABELS,
  SIMPLE_REOPEN_REASONS,
  STAGE_TONE_CLASSES,
  STAGE_TONES,
} from "./constants";

describe("ADVANCED_FEATURES registry", () => {
  it("has a meta entry per key, with the key echoed, and claims each route / API prefix once", () => {
    expect(ADVANCED_FEATURES).toHaveLength(22);
    expect(Object.keys(ADVANCED_FEATURE_META).sort()).toEqual([...ADVANCED_FEATURES].sort());
    const routes: string[] = [];
    const apis: string[] = [];
    for (const key of ADVANCED_FEATURES) {
      const meta = ADVANCED_FEATURE_META[key];
      expect(meta.key).toBe(key);
      expect(meta.label.length).toBeGreaterThan(0);
      routes.push(...meta.routes);
      apis.push(...meta.apiPrefixes);
    }
    expect(new Set(routes).size).toBe(routes.length);
    expect(new Set(apis).size).toBe(apis.length);
    for (const p of [...routes, ...apis]) expect(p).toMatch(/^\/[a-z]/);
    for (const feature of Object.values(ADVANCED_JOB_SUBPATHS)) expect(ADVANCED_FEATURES).toContain(feature);
  });

  it("owns the pages the plan hides (board, timeline, reports, workloads, workflows, automations, projects)", () => {
    const all = ADVANCED_FEATURES.flatMap((k) => ADVANCED_FEATURE_META[k].routes);
    for (const r of ["/workspace/kanban", "/workspace/timeline", "/insights/analytics", "/team/workloads", "/settings/workflows", "/settings/automations", "/projects"]) {
      expect(all).toContain(r);
    }
    // the simple pages are never advanced
    for (const r of ["/home", "/my-jobs", "/jobs", "/calendar", "/editors", "/clients", "/settings/studio", "/settings/people", "/settings/account"]) {
      expect(all).not.toContain(r);
    }
  });
});

describe("notification defaults (plan §8)", () => {
  it("8 groups; every group has at least one type; default-on + default-off + client types partition the list", () => {
    expect(NOTIFICATION_GROUPS).toHaveLength(8);
    for (const g of NOTIFICATION_GROUPS) expect(notificationTypesOfGroup(g).length).toBeGreaterThan(0);
    const union = [...DEFAULT_ON_NOTIFICATION_TYPES, ...DEFAULT_OFF_NOTIFICATION_TYPES, ...CLIENT_NOTIFICATION_TYPES].sort();
    expect(union).toEqual([...NOTIFICATION_TYPES].sort());
    expect(DEFAULT_ON_NOTIFICATION_TYPES).toHaveLength(12);
    // a grouped staff type is on; an ungrouped one is off; mandatory types are always on
    for (const t of NOTIFICATION_TYPES) {
      const meta = NOTIFICATION_TYPE_META[t];
      if ((CLIENT_NOTIFICATION_TYPES as readonly string[]).includes(t)) expect(meta.defaultOn).toBe(true);
      else expect(meta.defaultOn).toBe(meta.group !== null);
      if (meta.mandatory) expect(meta.defaultOn).toBe(true);
    }
    expect(DEFAULT_OFF_NOTIFICATION_TYPES).toContain("job_completed");
    expect(DEFAULT_OFF_NOTIFICATION_TYPES).toContain("automation");
    expect(DEFAULT_ON_NOTIFICATION_TYPES).toContain("job_overdue");
  });

  it("late summary dedupe key is per person per civil day", () => {
    expect(lateSummaryDedupeKey("u1", "2026-10-13")).toBe("late_summary:u1:2026-10-13");
    expect(lateSummaryDedupeKey("u1", "2026-10-14")).not.toBe(lateSummaryDedupeKey("u1", "2026-10-13"));
  });
});

describe("photographer presets (plan §2, decision 4)", () => {
  it("two presets: own shoots = create/assign/review on, view-all/workloads/analytics off; co-owner = admin", () => {
    expect(PHOTOGRAPHER_PRESETS).toEqual(["own_shoots", "co_owner"]);
    expect(presetSwitches("own_shoots")).toEqual({
      isAdmin: false,
      flags: { canCreateJobs: true, canAssignEditors: true, canReviewSubmissions: true, canViewAllJobs: false, canViewTeamWorkloads: false, canViewAnalytics: false },
    });
    expect(presetSwitches("co_owner").isAdmin).toBe(true);
    expect(Object.keys(PHOTOGRAPHER_PRESET_META.co_owner.flags).sort()).toEqual([...MEMBER_FLAGS].sort());
    expect(PHOTOGRAPHER_PRESET_META.own_shoots.label).toBe("Only their own shoots");
    expect(PHOTOGRAPHER_PRESET_META.co_owner.label).toBe("Everything (co-owner)");
  });

  it("photographerPresetOf reads the switches back; admins are co-owner; anything else is custom; editors/clients null", () => {
    expect(photographerPresetOf({ role: "photographer", isAdmin: true })).toBe("co_owner");
    expect(photographerPresetOf({ role: "photographer", isAdmin: false, ...presetSwitches("own_shoots").flags })).toBe("own_shoots");
    expect(photographerPresetOf({ role: "photographer", isAdmin: false, ...presetSwitches("own_shoots").flags, canViewAllJobs: true })).toBe("custom");
    expect(photographerPresetOf({ role: "photographer", isAdmin: false })).toBe("custom");
    expect(photographerPresetOf({ role: "editor" })).toBeNull();
    expect(photographerPresetOf({ role: "client" })).toBeNull();
  });
});

describe("small helpers", () => {
  it("normaliseProjectKey collapses whitespace and case", () => {
    expect(normaliseProjectKey("  123   Smith STREET ")).toBe("123 smith street");
    expect(normaliseProjectKey(null)).toBe("");
  });
  it("rush <-> priority", () => {
    expect(priorityForRush(true)).toBe("urgent");
    expect(priorityForRush(false)).toBe("normal");
    expect(isRushPriority("urgent")).toBe(true);
    expect(isRushPriority("high")).toBe(false);
  });
  it("reopen reasons, stage tones and the login-box accounts", () => {
    expect(SIMPLE_REOPEN_REASONS).toEqual(["client_changes", "fix_delivery_link"]);
    for (const r of SIMPLE_REOPEN_REASONS) expect(SIMPLE_REOPEN_REASON_LABELS[r].length).toBeGreaterThan(0);
    for (const t of STAGE_TONES) expect(STAGE_TONE_CLASSES[t].pill).toContain(`stage-${t}`);
    expect(DEMO_ACCOUNTS.map((a) => a.email)).toEqual(["owner@studio.test", "photographer01@studio.test", "editor01@studio.test", "client@studio.test"]);
  });
});
