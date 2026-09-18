import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import { jobQuantities, workerJobs } from "./workerQuantities";
import type { Order, OrderLineJob, Material } from "../types/domain";
const base = {materialId:"a",materialSnapshot:{sheetLengthMm:2800,sheetWidthMm:2070}} as Order;
const job = {index:0,materialId:"a",materialName:"Ақ",sheetQty:10,confirmedSheets:8,pvcMeters:12.75} as OrderLineJob;
describe("worker quantities",()=>{
 it("uses confirmed sheets and converts mm² to m²",()=>{expect(jobQuantities(base,job,[])).toEqual({sheets:8,area:46.368,pvcMeters:12.75});});
 it("does not apply primary board dimensions to a second material",()=>{expect(jobQuantities(base,{...job,materialId:"b"},[]).area).toBeNull();expect(jobQuantities(base,{...job,materialId:"b"},[{id:"b",sheetLengthMm:1000,sheetWidthMm:1000} as Material]).area).toBe(8);});
 it("keeps each worker's completed lines separate from unfinished and coworker lines",()=>{const now=Timestamp.now(); const order={...base,lineJobs:[{...job,cuttingByUid:"me",cuttingCompletedAt:now},{...job,index:1,cuttingByUid:"other",cuttingCompletedAt:now},{...job,index:2,cuttingByUid:"me",cuttingStartedAt:now}]};expect(workerJobs(order,"cutting","me",true).map(j=>j.index)).toEqual([0]);expect(workerJobs(order,"cutting","me",false).map(j=>j.index)).toEqual([2]);});
});
