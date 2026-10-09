import { describe, expect, it } from "vitest";
import { horizontalClampShift, VIEWPORT_GUTTER } from "./floating";

describe("horizontalClampShift", () => {
  it("leaves a box that already fits alone", () => {
    expect(horizontalClampShift(16, 288, 390)).toBe(0);
    expect(horizontalClampShift(100, 200, 1280)).toBe(0);
  });

  it("pulls a start-aligned popover back from the right edge (390px phone)", () => {
    // Priority filter on /workspace/all: left 238, width 288 → right edge 526.
    const shift = horizontalClampShift(238, 288, 390);
    expect(238 + shift + 288).toBe(390 - VIEWPORT_GUTTER);
  });

  it("pushes an end-aligned popover back in from the left edge", () => {
    // Column chooser: left -151.
    const shift = horizontalClampShift(-151, 288, 390);
    expect(-151 + shift).toBe(VIEWPORT_GUTTER);
  });

  it("pins a box wider than the viewport to the left gutter", () => {
    expect(horizontalClampShift(40, 400, 390)).toBe(VIEWPORT_GUTTER - 40);
  });

  it("honours a custom gutter", () => {
    expect(horizontalClampShift(0, 100, 300, 8)).toBe(8);
    expect(horizontalClampShift(250, 100, 300, 8)).toBe(-58);
  });
});
