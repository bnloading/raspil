import { describe, it, expect } from "vitest";
import type { Timestamp } from "firebase/firestore";
import { mdfOrderHeadingTo, mdfRouteFor, mdfStageFor, nextMdfStage } from "./mdfRoute";

const done = { completedAt: { seconds: 1, nanoseconds: 0 } as unknown as Timestamp };

describe("mdfRouteFor — the stations an order passes", () => {
  it("sends film to the vacuum press and paint to the paint shop, never both", () => {
    expect(mdfRouteFor({ mdfFinish: "film" })).toEqual(["cnc", "sanding", "vacuum"]);
    expect(mdfRouteFor({ mdfFinish: "paint" })).toEqual(["cnc", "sanding", "painting"]);
  });

  it("reads an order with no finish recorded as film — the wrap line's every order so far", () => {
    expect(mdfRouteFor({})).toEqual(["cnc", "sanding", "vacuum"]);
  });
});

describe("nextMdfStage", () => {
  it("takes a sanded film order to the vacuum press, not to «Краска»", () => {
    // №562, 28.10: sanded by Арман, then stuck at «Краска», where nobody paints.
    expect(nextMdfStage({}, "sanding")).toBe("vacuum");
    expect(nextMdfStage({ mdfFinish: "paint" }, "sanding")).toBe("painting");
  });

  it("finishes the order after its last station", () => {
    expect(nextMdfStage({ mdfFinish: "film" }, "vacuum")).toBeUndefined();
    expect(nextMdfStage({ mdfFinish: "paint" }, "painting")).toBeUndefined();
  });

  it("moves an order off a station its finish does not use to the next one it does", () => {
    expect(nextMdfStage({ mdfFinish: "film" }, "painting")).toBe("vacuum");
    expect(nextMdfStage({ mdfFinish: "paint" }, "vacuum")).toBeUndefined();
  });
});

describe("mdfStageFor — where an order in production belongs", () => {
  it("is the first station of its route not yet finished", () => {
    expect(mdfStageFor({ mdfStageJobs: {} })).toBe("cnc");
    expect(mdfStageFor({ mdfStageJobs: { cnc: done, sanding: done } })).toBe("vacuum");
    expect(mdfStageFor({ mdfFinish: "paint", mdfStageJobs: { cnc: done, sanding: done } })).toBe("painting");
  });

  it("is undefined once every station of the route is done", () => {
    expect(mdfStageFor({ mdfStageJobs: { cnc: done, sanding: done, vacuum: done } })).toBeUndefined();
  });
});

describe("mdfOrderHeadingTo — a station's «келе жатыр» list", () => {
  it("shows the vacuum press the film orders still on their way, and not the paint ones", () => {
    expect(mdfOrderHeadingTo({ mdfStage: "cnc" }, "vacuum")).toBe(true);
    expect(mdfOrderHeadingTo({ mdfStage: "cnc", mdfFinish: "paint" }, "vacuum")).toBe(false);
    expect(mdfOrderHeadingTo({ mdfStage: "cnc", mdfFinish: "paint" }, "painting")).toBe(true);
  });

  it("does not list an order already at or past the station", () => {
    expect(mdfOrderHeadingTo({ mdfStage: "vacuum" }, "vacuum")).toBe(false);
    expect(mdfOrderHeadingTo({ mdfStage: "vacuum" }, "sanding")).toBe(false);
  });
});
