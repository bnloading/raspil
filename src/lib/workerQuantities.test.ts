import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import { cutCountsOfJobs, jobQuantities, workerJobs } from "./workerQuantities";
import type { Order, OrderLineJob, Material } from "../types/domain";
const base = {materialId:"a",materialSnapshot:{sheetLengthMm:2800,sheetWidthMm:2070}} as Order;
const job = {index:0,materialId:"a",materialName:"Ақ",sheetQty:10,confirmedSheets:8,pvcMeters:12.75} as OrderLineJob;
describe("worker quantities",()=>{
 it("uses confirmed sheets and converts mm² to m²",()=>{expect(jobQuantities(base,job,[])).toEqual({sheets:8,area:46.368,pvcMeters:12.75});});
 it("does not apply primary board dimensions to a second material",()=>{expect(jobQuantities(base,{...job,materialId:"b"},[]).area).toBeNull();expect(jobQuantities(base,{...job,materialId:"b"},[{id:"b",sheetLengthMm:1000,sheetWidthMm:1000} as Material]).area).toBe(8);});
 it("keeps each worker's completed lines separate from unfinished and coworker lines",()=>{const now=Timestamp.now(); const order={...base,lineJobs:[{...job,cuttingByUid:"me",cuttingCompletedAt:now},{...job,index:1,cuttingByUid:"other",cuttingCompletedAt:now},{...job,index:2,cuttingByUid:"me",cuttingStartedAt:now}]};expect(workerJobs(order,"cutting","me",true).map(j=>j.index)).toEqual([0]);expect(workerJobs(order,"cutting","me",false).map(j=>j.index)).toEqual([2]);});
});

describe("cutCountsOfJobs — лист, ХДФ and столешница apart, as the week's pay counts them", () => {
  const materials = [
    { id: "ldsp", category: "ldsp" }, { id: "hdf", category: "hdf" }, { id: "mdf", category: "mdf" },
    { id: "top", category: "countertop" }, { id: "misc", category: "other" },
  ] as Material[];
  const line = (materialId: string, sheets: number, materialName = "") =>
    ({ ...job, materialId, materialName, sheetQty: sheets, confirmedSheets: undefined });

  it("sorts lines into ХДФ and столешница by the catalogue, every other board — МДФ too — a лист", () => {
    expect(cutCountsOfJobs([line("ldsp", 10), line("hdf", 3), line("mdf", 2), line("top", 1), line("misc", 4)], materials))
      .toEqual({ sheets: 16, hdf: 3, countertop: 1 });
  });

  it("counts what the cutter confirmed, and reads a material since deleted by its name", () => {
    expect(cutCountsOfJobs([{ ...job, materialId: "gone", materialName: "ХДФ ақ" }, line("gone", 2, "Столешница Симал")], materials))
      .toEqual({ sheets: 0, hdf: 8, countertop: 2 });
  });
});
