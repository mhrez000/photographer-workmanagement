import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, resolveDatabasePath, resolveTemplatePath, HOSTED_DEMO_DATABASE_PATH } from "./index";

const saved = { ...process.env };
afterEach(() => {
  for (const key of ["VERCEL", "DATABASE_PATH", "DEMO_DB_TEMPLATE"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("hosted demo database", () => {
  it("uses /tmp on Vercel unless DATABASE_PATH is set", () => {
    process.env.VERCEL = "1";
    delete process.env.DATABASE_PATH;
    expect(resolveDatabasePath()).toBe(HOSTED_DEMO_DATABASE_PATH);
    expect(path.basename(resolveTemplatePath() ?? "")).toBe("demo.db");
    process.env.DATABASE_PATH = "./data/custom.db";
    expect(path.basename(resolveDatabasePath())).toBe("custom.db");
    expect(resolveTemplatePath()).toBeNull();
  });

  it("copies the template into an empty path and never overwrites an existing database", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pwm-demo-"));
    const template = path.join(dir, "template.db");
    const seeded = createDatabase(template, { installGuards: false });
    seeded.sqlite.exec("create table marker (v text); insert into marker values ('from-template');");
    seeded.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    seeded.sqlite.close();

    process.env.DEMO_DB_TEMPLATE = template;
    const target = path.join(dir, "runtime.db");
    const first = createDatabase(target, { installGuards: false });
    expect(first.sqlite.prepare("select v from marker").get()).toEqual({ v: "from-template" });
    first.sqlite.exec("update marker set v = 'changed'");
    first.sqlite.close();

    const again = createDatabase(target, { installGuards: false });
    expect(again.sqlite.prepare("select v from marker").get()).toEqual({ v: "changed" });
    again.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
