import { describe, expect, it } from "vitest";
import { EDITOR_INVITE_DEFAULTS, MEMBER_FLAGS, MEMBER_INVITE_DEFAULTS, PERSONAS } from "@/lib/constants";
import {
  PERSONA_BADGE,
  editorAccessSummary,
  editorFlagsOf,
  inviteMessage,
  memberAccessSummary,
  memberFlagsOf,
  type MemberFlagValues,
} from "./permission-copy";

const allOff = Object.fromEntries(MEMBER_FLAGS.map((f) => [f, false])) as MemberFlagValues;
const allOn = Object.fromEntries(MEMBER_FLAGS.map((f) => [f, true])) as MemberFlagValues;

describe("memberAccessSummary (docs/ROLES.md §2.2 live sentence)", () => {
  it("matches the contract example for create + assign", () => {
    expect(memberAccessSummary({ ...allOff, canCreateJobs: true, canAssignEditors: true })).toBe(
      "They'll be able to: create jobs, assign editors on their jobs. Reviews of their jobs come to you.",
    );
  });

  it("invite defaults: create + assign, reviews come to the owner", () => {
    const s = memberAccessSummary(MEMBER_INVITE_DEFAULTS);
    expect(s).toContain("create jobs");
    expect(s).toContain("assign editors on their jobs");
    expect(s).toContain("Reviews of their jobs come to you.");
    expect(s).not.toContain("review, deliver");
  });

  it("every switch on: lists every ability and no hand-off sentences", () => {
    const s = memberAccessSummary(allOn);
    for (const phrase of ["create jobs", "assign editors", "review, deliver and complete", "see team workload", "see every job", "see analytics"]) {
      expect(s).toContain(phrase);
    }
    expect(s).not.toContain("come to you");
    expect(s).not.toContain("You assign editors");
  });

  it("nothing on: own jobs only, and the owner assigns and reviews", () => {
    const s = memberAccessSummary(allOff);
    expect(s).toContain("their own jobs only");
    expect(s).toContain("You assign editors to their jobs.");
    expect(s).toContain("Reviews of their jobs come to you.");
  });

  it("admin overrides the switches", () => {
    const s = memberAccessSummary(allOff, { isAdmin: true });
    expect(s).toContain("everything you can");
    expect(s).toContain("except change the primary owner");
  });

  it("never says manager", () => {
    for (const s of [memberAccessSummary(allOff), memberAccessSummary(allOn), memberAccessSummary(allOn, { isAdmin: true })]) {
      expect(s.toLowerCase()).not.toContain("manager");
    }
  });
});

describe("editorAccessSummary", () => {
  it("defaults: nothing extra (editors cannot add jobs by default, plan §2)", () => {
    expect(editorAccessSummary(EDITOR_INVITE_DEFAULTS)).toBe("They'll see and edit only the jobs assigned to them.");
  });
  it("both on", () => {
    expect(editorAccessSummary({ canCreateJobs: true, canViewTeamJobs: true })).toContain("see other editors' jobs (read-only)");
  });
  it("both off", () => {
    expect(editorAccessSummary({ canCreateJobs: false, canViewTeamJobs: false })).toBe("They'll see and edit only the jobs assigned to them.");
  });
});

describe("inviteMessage (§6.1 Copy invite message)", () => {
  it("is the contract text, with a normalised origin", () => {
    expect(inviteMessage({ studio: "Northlight Studios", origin: "https://proofline.test/", email: "sam@x.test", password: "Temp-123" })).toBe(
      "You've been invited to Northlight Studios on Proofline. Sign in at https://proofline.test/login with sam@x.test and the temporary password Temp-123. You'll be asked to choose a new password.",
    );
  });
});

describe("flag pickers", () => {
  it("memberFlagsOf treats null/undefined as off and ignores other keys", () => {
    const picked = memberFlagsOf({ canCreateJobs: true, canAssignEditors: null, canViewAllJobs: undefined });
    expect(picked).toEqual({ ...allOff, canCreateJobs: true });
    expect(Object.keys(picked).sort()).toEqual([...MEMBER_FLAGS].sort());
  });
  it("editorFlagsOf picks the two editor switches", () => {
    expect(editorFlagsOf({ canCreateJobs: false, canViewTeamJobs: true })).toEqual({ canCreateJobs: false, canViewTeamJobs: true });
  });
});

describe("PERSONA_BADGE (§11)", () => {
  it("covers every persona with the contract variants", () => {
    expect(Object.keys(PERSONA_BADGE).sort()).toEqual([...PERSONAS].sort());
    expect(PERSONA_BADGE).toEqual({ admin: "solid", member: "info", editor: "neutral", client: "outline" });
  });
});
