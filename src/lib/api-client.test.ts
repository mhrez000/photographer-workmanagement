/**
 * The browser API client's 401 handling (src/lib/api-client.ts): a 401 normally means "your session ended" and sends
 * the page to /login?expired=1 — but a public call whose 401 means something else (the demo panel, DEMO-01: "that
 * persona can't be opened right now") opts out with `redirectOn401: false` and shows its own words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api-client";

const assign = vi.fn();

beforeEach(() => {
  vi.stubGlobal("window", { location: { pathname: "/login", search: "?demo=1", assign } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "Incorrect email or password" } }), { status: 401 })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  assign.mockReset();
});

describe("api client: 401", () => {
  it("by default a 401 sends the page to sign in again (the session ended)", async () => {
    await expect(api.post("/api/jobs/x/notes", {})).rejects.toBeInstanceOf(ApiError);
    expect(assign).toHaveBeenCalledWith(`/login?expired=1&next=${encodeURIComponent("/login?demo=1")}`);
  });

  it("redirectOn401: false leaves the page where it is and hands the 401 to the caller", async () => {
    const err = await api.post("/api/auth/demo", { persona: "client" }, { redirectOn401: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(assign).not.toHaveBeenCalled();
  });
});
