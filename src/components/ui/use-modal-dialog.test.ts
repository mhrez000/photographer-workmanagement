import { describe, expect, it } from "vitest";
import { AUTOFOCUS_SELECTOR, focusInitialElement } from "./use-modal-dialog";

function fakeEl(name: string, log: string[], disabled = false) {
  return {
    name,
    focus: () => log.push(name),
    matches: (selector: string) => selector === ":disabled" && disabled,
  };
}

function fakeRoot(elements: ReturnType<typeof fakeEl>[]) {
  const queries: string[] = [];
  return {
    queries,
    querySelectorAll: (selector: string) => {
      queries.push(selector);
      return elements;
    },
  };
}

describe("focusInitialElement (modal initial focus)", () => {
  it("queries both data-autofocus and the native autofocus attribute", () => {
    expect(AUTOFOCUS_SELECTOR).toContain("[data-autofocus]");
    expect(AUTOFOCUS_SELECTOR).toContain("[autofocus]");
    const root = fakeRoot([]);
    focusInitialElement(root);
    expect(root.queries).toEqual([AUTOFOCUS_SELECTOR]);
  });

  it("focuses the marked field instead of leaving focus on the first focusable (Close / cmdk root)", () => {
    const log: string[] = [];
    expect(focusInitialElement(fakeRoot([fakeEl("cmdk-input", log)]))).toBe(true);
    expect(log).toEqual(["cmdk-input"]);
  });

  it("skips disabled candidates", () => {
    const log: string[] = [];
    focusInitialElement(fakeRoot([fakeEl("disabled", log, true), fakeEl("reason", log)]));
    expect(log).toEqual(["reason"]);
  });

  it("falls back to the platform default when nothing is marked", () => {
    const log: string[] = [];
    expect(focusInitialElement(fakeRoot([]))).toBe(false);
    expect(focusInitialElement(fakeRoot([fakeEl("disabled", log, true)]))).toBe(false);
    expect(log).toEqual([]);
  });
});
