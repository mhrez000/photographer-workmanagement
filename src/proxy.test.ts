/** Edge landing-page hints (docs/SIMPLIFICATION-PLAN.md §3): unverified `k` / `r` claims decide where a cookie lands. */
import { describe, expect, it } from "vitest";
import { CLIENT_HOME, EDITOR_HOME, landingFor, sessionHintOf, STAFF_HOME } from "./proxy";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = (claims: object) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;

describe("sessionHintOf / landingFor", () => {
  it("reads kind and role from the claims; missing or unreadable cookies count as a staff photographer", () => {
    expect(sessionHintOf(undefined)).toEqual({ kind: "staff", role: "photographer" });
    expect(sessionHintOf("not-a-jwt")).toEqual({ kind: "staff", role: "photographer" });
    expect(sessionHintOf(token({ sub: "u", k: "client" }))).toEqual({ kind: "client", role: "client" });
    expect(sessionHintOf(token({ sub: "u", k: "staff", r: "editor" }))).toEqual({ kind: "staff", role: "editor" });
    expect(sessionHintOf(token({ sub: "u", k: "staff", r: "photographer" }))).toEqual({ kind: "staff", role: "photographer" });
    expect(sessionHintOf(token({ sub: "u", k: "staff" }))).toEqual({ kind: "staff", role: "photographer" }); // pre-plan cookie without r
  });
  it("clients land on /portal, editors on /my-jobs, photographers on /home", () => {
    expect(landingFor({ kind: "client", role: "client" })).toBe(CLIENT_HOME);
    expect(landingFor({ kind: "staff", role: "editor" })).toBe(EDITOR_HOME);
    expect(landingFor({ kind: "staff", role: "photographer" })).toBe(STAFF_HOME);
    expect([CLIENT_HOME, EDITOR_HOME, STAFF_HOME]).toEqual(["/portal", "/my-jobs", "/home"]);
  });
});
