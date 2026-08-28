import { describe, it, expect } from "vitest";
import { boardProgress, boardSummary } from "./boardProgress";
import type { WorkshopBoardStage } from "../types/domain";

const at = (stage: WorkshopBoardStage, needsPvc = true) =>
  Object.fromEntries(boardProgress(stage, needsPvc).map((s) => [s.label, s.state]));

describe("boardProgress", () => {
  it("never starts at Төлем — the board carries no payment data", () => {
    expect(boardProgress("queue", true).map((s) => s.label)).toEqual(["Кезек", "Распил", "ПВХ", "Дайын"]);
  });

  it("in the queue: waiting to start", () => {
    expect(at("queue")).toEqual({ Кезек: "active", Распил: "pending", ПВХ: "pending", Дайын: "pending" });
  });

  it("being cut: the queue is behind it", () => {
    expect(at("cutting")).toEqual({ Кезек: "done", Распил: "active", ПВХ: "pending", Дайын: "pending" });
  });

  it("waiting for PVC: cutting is finished", () => {
    expect(at("pvc_wait")).toEqual({ Кезек: "done", Распил: "done", ПВХ: "active", Дайын: "pending" });
  });

  it("having PVC applied", () => {
    expect(at("pvc")).toEqual({ Кезек: "done", Распил: "done", ПВХ: "active", Дайын: "pending" });
  });

  it("ready: everything behind it is done", () => {
    expect(at("ready")).toEqual({ Кезек: "done", Распил: "done", ПВХ: "done", Дайын: "done" });
  });

  it("skips ПВХ entirely on an order that needs none", () => {
    expect(at("cutting", false).ПВХ).toBe("skipped");
    expect(at("ready", false).ПВХ).toBe("skipped");
  });
});

describe("boardSummary", () => {
  it("gives the queue position, counting from one", () => {
    expect(boardSummary("queue", 0)).toBe("Кезекте · №1");
    expect(boardSummary("queue", 3)).toBe("Кезекте · №4");
  });

  it("names the running stage", () => {
    expect(boardSummary("cutting", 0)).toBe("Кесіліп жатыр");
    expect(boardSummary("pvc_wait", 0)).toBe("ПВХ кезегінде");
    expect(boardSummary("pvc", 0)).toBe("ПВХ жасалып жатыр");
    expect(boardSummary("ready", 0)).toBe("Дайын");
  });
});
