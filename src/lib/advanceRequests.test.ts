import { describe, it, expect } from "vitest";
import type { Timestamp } from "firebase/firestore";
import type { AdvanceRequest } from "../types/domain";
import { advanceExpenseName, ownRequests, pendingForLine } from "./advanceRequests";

const at = (iso: string) => ({ seconds: Math.floor(Date.parse(iso) / 1000), nanoseconds: 0 }) as unknown as Timestamp;
let seq = 0;
const req = (over: Partial<AdvanceRequest>): AdvanceRequest => ({
  id: `r${++seq}`, userId: "olzhas", userName: "Олжас", role: "raspil", department: "ldsp", amountTiyn: 5000000,
  comment: "", status: "pending", createdAt: at("2026-11-09T10:00:00+05:00"), ...over,
});

describe("«Аванс сұрау» — the pure parts", () => {
  it("names the Касса expense the way the counter does by hand", () => {
    expect(advanceExpenseName(" Олжас ")).toBe("Олжас — аванс");
  });

  it("shows a line's Manager only that line's requests still waiting, the earliest first", () => {
    const late = req({ createdAt: at("2026-11-09T12:00:00+05:00") });
    const early = req({ createdAt: at("2026-11-09T09:00:00+05:00") });
    const mdf = req({ department: "mdf", role: "vacuum", userName: "Аманжол" });
    const done = req({ status: "approved" });
    expect(pendingForLine([late, mdf, done, early], "ldsp")).toEqual([early, late]);
    expect(pendingForLine([late, mdf, done, early], "mdf")).toEqual([mdf]);
  });

  it("puts a worker's waiting request apart from the ones already answered, newest first", () => {
    const old = req({ status: "approved", createdAt: at("2026-11-01T10:00:00+05:00") });
    const declined = req({ status: "declined", createdAt: at("2026-11-05T10:00:00+05:00") });
    const waiting = req({ createdAt: undefined }); // just sent: the server time is not back yet
    expect(ownRequests([old, waiting, declined])).toEqual({ pending: waiting, history: [declined, old] });
    expect(ownRequests([old]).pending).toBeNull();
  });
});
