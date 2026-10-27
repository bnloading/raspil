import { describe, it, expect } from "vitest";
import { getNavForRole } from "./navConfig";

const phoneBar = (role: "admin" | "manager", department: "ldsp" | "mdf") =>
  getNavForRole(role, department).filter((item) => item.mobile).slice(0, 6).map((item) => item.short ?? item.label);
const keys = (role: "admin" | "manager", department: "ldsp" | "mdf") => getNavForRole(role, department).map((i) => i.key);

describe("navConfig — the two lines keep to their own pages", () => {
  it("gives the МДФ counter its journal and «Қолма-қол» on the phone bar, in Аренда's place", () => {
    expect(phoneBar("manager", "mdf")).toEqual(["Басты", "Журнал", "Төлем", "Қойма", "Касса", "Қолма-қол"]);
  });

  it("leaves the ЛДСП counter's phone bar as it was", () => {
    expect(phoneBar("manager", "ldsp")).toEqual(["Басты", "Журнал", "Распил", "Қойма", "Касса", "Аренда"]);
  });

  it("shows МДФ neither Аренда nor ЛДСП's journal, queues or sheet catalogue", () => {
    for (const role of ["admin", "manager"] as const) {
      const mdf = keys(role, "mdf");
      for (const ldspOnly of ["admin-rent", "manager-rent", "assortment", "manager-journal", "admin-journal", "manager-cutting"]) {
        expect(mdf, `${role}: ${ldspOnly}`).not.toContain(ldspOnly);
      }
    }
  });

  it("shows ЛДСП none of the МДФ line's pages", () => {
    for (const role of ["admin", "manager"] as const) {
      const ldsp = keys(role, "ldsp");
      for (const mdfOnly of ["manager-mdf-journal", "admin-mdf-journal", "admin-mdf", "manager-cash", "admin-cash"]) {
        expect(ldsp, `${role}: ${mdfOnly}`).not.toContain(mdfOnly);
      }
    }
  });

  it("gives the МДФ admin the МДФ journal and the cash book", () => {
    expect(keys("admin", "mdf")).toEqual(expect.arrayContaining(["admin-mdf-journal", "admin-cash"]));
  });
});
