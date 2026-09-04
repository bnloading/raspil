import { describe, it, expect } from "vitest";
import { boardProgress, boardSummary, customersAhead} from "./boardProgress";
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

  describe("МДФ orders", () => {
    it("collapses to three milestones instead of the распил/ПВХ four", () => {
      expect(boardProgress("mdf", true, "mdf_wrap").map((s) => s.label)).toEqual(["Кезек", "МДФ", "Дайын"]);
    });
    it("МДФ step is active while in production, done once ready", () => {
      const mdf = Object.fromEntries(boardProgress("mdf", true, "mdf_wrap").map((s) => [s.label, s.state]));
      expect(mdf.МДФ).toBe("active");
      expect(mdf.Дайын).toBe("pending");
      const ready = Object.fromEntries(boardProgress("ready", true, "mdf_wrap").map((s) => [s.label, s.state]));
      expect(ready.МДФ).toBe("done");
      expect(ready.Дайын).toBe("done");
    });
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
    expect(boardSummary("mdf", 0)).toBe("МДФ өндірісінде");
  });
});

describe("customersAhead", () => {
  const at = (id: string, queuePosition: number, customerName: string, stage: WorkshopBoardStage = "queue") =>
    ({ id, queuePosition, customerName, stage });

  const mine = at("mine", 5, "Дин");

  it("counts the people in front, not the jobs", () => {
    // Ерлан has two orders waiting; he is still one customer to be served.
    const ahead = customersAhead(
      [at("a", 1, "Ерлан"), at("b", 2, "Ерлан"), at("c", 3, "Нурик"), mine],
      mine,
    );
    expect(ahead).toBe(2);
  });

  it("ignores anything already off the queue", () => {
    expect(customersAhead(
      [at("a", 1, "Ерлан", "cutting"), at("b", 2, "Нурик", "pvc"), at("c", 3, "Асет"), mine],
      mine,
    )).toBe(1);
  });

  it("ignores everyone behind you", () => {
    expect(customersAhead([at("a", 7, "Ерлан"), at("b", 9, "Нурик"), mine], mine)).toBe(0);
  });

  it("is zero at the front of the queue", () => {
    const first = at("first", 0, "Дин");
    expect(customersAhead([first, at("a", 3, "Ерлан")], first)).toBe(0);
  });

  it("does not count your own other orders as people ahead of you", () => {
    expect(customersAhead([at("a", 1, "Дин"), at("b", 2, "Нурик"), mine], mine)).toBe(1);
  });

  it("counts a nameless row as one person rather than dropping it", () => {
    // Over-counting is the honest direction to be wrong in when somebody is waiting.
    expect(customersAhead([at("a", 1, ""), at("b", 2, ""), at("c", 3, "Нурик"), mine], mine)).toBe(3);
  });

  it("treats the same name in different cases and spacing as one person", () => {
    expect(customersAhead([at("a", 1, "Ерлан"), at("b", 2, " ерлан "), mine], mine)).toBe(1);
  });
});
