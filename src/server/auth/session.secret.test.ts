import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SESSION_SECRET resolution at module load (session.ts): explicit env wins,
 * then data/.session-secret, then — outside production only — a generated
 * secret persisted to data/.session-secret.
 */
describe("session secret", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pwm-secret-"));
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("generates and persists a secret in development when none is configured", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("NODE_ENV", "development");
    const first = await import("./session");
    const token = await first.signSessionToken({ sub: "u1", sv: 1 });
    const file = path.join(dir, "data", ".session-secret");
    expect(fs.readFileSync(file, "utf8").trim().length).toBeGreaterThanOrEqual(32);

    // A restart reuses the same file → existing sessions stay valid.
    vi.resetModules();
    const second = await import("./session");
    expect(await second.verifySessionToken(token)).toEqual({ sub: "u1", sv: 1 });
  });

  it("never generates one in production", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    await expect(import("./session")).rejects.toThrow(/SESSION_SECRET is missing/);
    expect(fs.existsSync(path.join(dir, "data", ".session-secret"))).toBe(false);
  });

  it("an explicit SESSION_SECRET wins and writes nothing", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", "explicit-secret-explicit-secret-explicit-secret");
    await import("./session");
    expect(fs.existsSync(path.join(dir, "data", ".session-secret"))).toBe(false);
  });
});
