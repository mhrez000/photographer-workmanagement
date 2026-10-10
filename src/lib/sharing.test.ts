import { describe, expect, it } from "vitest";
import { addedAfterApproval, defaultDeliverySelection } from "./sharing";

const link = (id: string, kind: "gallery" | "client_delivery" | "finished_files" | "raw_files" | "reference", sharedWithClient = false) => ({ id, kind, sharedWithClient });

describe("defaultDeliverySelection (Deliver dialog, ROLES.md §7.3)", () => {
  it("pre-selects gallery and client-delivery links", () => {
    expect(defaultDeliverySelection([link("g", "gallery"), link("c", "client_delivery"), link("f", "finished_files"), link("r", "raw_files")])).toEqual(["g", "c"]);
  });
  it("falls back to finished files when there is no gallery / client-delivery link", () => {
    expect(defaultDeliverySelection([link("f1", "finished_files"), link("r", "raw_files"), link("f2", "finished_files")])).toEqual(["f1", "f2"]);
  });
  it("selects nothing when there is nothing deliverable (raw files and references are never pre-selected)", () => {
    expect(defaultDeliverySelection([link("r", "raw_files"), link("x", "reference")])).toEqual([]);
    expect(defaultDeliverySelection([])).toEqual([]);
  });
});

describe("addedAfterApproval", () => {
  it("flags links created after the last approval only", () => {
    expect(addedAfterApproval({ createdAt: "2026-10-09T02:00:00.000Z" }, "2026-10-09T01:00:00.000Z")).toBe(true);
    expect(addedAfterApproval({ createdAt: "2026-10-09T00:00:00.000Z" }, "2026-10-09T01:00:00.000Z")).toBe(false);
    expect(addedAfterApproval({ createdAt: "2026-10-09T02:00:00.000Z" }, null)).toBe(false);
  });
});
