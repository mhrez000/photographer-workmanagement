import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("legacy route redirects (next.config.ts)", () => {
  it("sends the spec's old paths to the ARCHITECTURE §10 routes with a temporary redirect", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    const bySource = new Map(redirects.map((r) => [r.source, r]));
    const expected: Record<string, string> = {
      "/workspace/my-work": "/workspace/my",
      "/workspace/all-work": "/workspace/all",
      "/workspace/team-work": "/workspace/team",
      "/team/editors/:id": "/team/users/:id",
      "/team/photographers/:id": "/team/users/:id",
    };
    for (const [source, destination] of Object.entries(expected)) {
      const rule = bySource.get(source);
      expect(rule, source).toBeDefined();
      expect(rule?.destination).toBe(destination);
      expect(rule && "permanent" in rule ? rule.permanent : undefined).toBe(false);
    }
  });

  it("never shadows a canonical route", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    const sources = redirects.map((r) => r.source);
    for (const canonical of ["/workspace/my", "/workspace/all", "/workspace/team", "/team/editors", "/team/photographers", "/team/users/:id"]) {
      expect(sources).not.toContain(canonical);
    }
  });
});
