/**
 * Plain-words copy shared by the front-door pages (review fixes UX-02 / UX-04 / UX-06 / UX-11 / UX-14 and SEC-01's
 * "use_password" answer). Pure helpers: no DOM.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDemoAccountEmail } from "@/lib/constants";
import { DEAD_LINK_CHECK, INVALID_RESET_BODY, LOG_OUT_EVERYWHERE_NOTE, homeLabelFor, invalidInviteBody } from "./auth-helpers";
import { googleResultMessage } from "./google-sign-in";

describe("front-door copy", () => {
  it("UX-11: the way back home fits the person", () => {
    expect(homeLabelFor("photographer")).toBe("Go to your studio");
    expect(homeLabelFor("editor")).toBe("Go to my jobs");
    expect(homeLabelFor("client")).toBe("See your work");
  });

  it("UX-03 / UX-04: logging out is called logging out, and says it reaches every device", () => {
    expect(LOG_OUT_EVERYWHERE_NOTE).toBe("Logging out also logs you out on your other devices.");
    expect(LOG_OUT_EVERYWHERE_NOTE).not.toMatch(/sign(ed|ing)? out/i);
  });

  it("UX-04: no screen, email or History line says 'sign(s/ed) … out' (comments and identifiers aside)", () => {
    const roots = ["src/app", "src/components", "src/server/email", "src/server/services", "src/lib/audit-summaries.ts", "src/lib/constants.ts"];
    const files: string[] = [];
    const walk = (p: string) => {
      if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
      else if (/\.(ts|tsx)$/.test(p) && !/\.test\.ts$/.test(p)) files.push(p);
    };
    roots.forEach((r) => walk(join(process.cwd(), r)));
    const signOut = /\b[Ss]ign(?:s|ed|ing)? (?:(?:them|you|everyone|people) )?out\b/;
    const offenders: string[] = [];
    for (const file of files) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      code.split("\n").forEach((line, i) => {
        if (signOut.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(files.length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });

  it("UX-06 / UX-14: a dead invite leads with 'already joined? sign in' signed out, never says the page didn't open", () => {
    const signedOut = invalidInviteBody("Harbour Light");
    expect(signedOut.startsWith("Already joined? Sign in below.")).toBe(true);
    expect(signedOut).toContain("ask Harbour Light for a new one");
    const signedIn = invalidInviteBody(null, { signedIn: true });
    expect(signedIn.startsWith(DEAD_LINK_CHECK)).toBe(true);
    expect(signedIn).not.toMatch(/sign in/i);
    for (const body of [signedOut, signedIn, INVALID_RESET_BODY]) expect(body).not.toMatch(/didn.t open/);
  });

  it("SEC-01: Google never takes over an account with a password — the sign-in page says what to do instead", () => {
    const msg = googleResultMessage("use_password", "signin");
    expect(msg?.tone).toBe("attention");
    expect(msg?.text).toMatch(/already a Proofline account with that email\. Sign in with your password/);
    expect(msg?.text).toMatch(/turn on Google in My account/);
    // Not an account-page answer.
    expect(googleResultMessage("use_password", "account")).toBeNull();
  });

  it("demo persona addresses are recognised without the server (the client card hides what the demo refuses)", () => {
    expect(isDemoAccountEmail(" Client@Studio.test ")).toBe(true);
    expect(isDemoAccountEmail("owner@studio.test")).toBe(true);
    expect(isDemoAccountEmail("someone@studio.test")).toBe(false);
    expect(isDemoAccountEmail(null)).toBe(false);
  });
});
