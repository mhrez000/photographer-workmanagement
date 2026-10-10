/**
 * vitest setupFiles entry (vitest.config.mts): closes every PGlite test
 * database opened during a test (makeTestDb in beforeEach or in the test).
 */
import { afterEach } from "vitest";
import { setDbOverride } from "./index";
import { closeTestDbs } from "./test-db";

afterEach(async () => {
  setDbOverride(null);
  await closeTestDbs();
});
