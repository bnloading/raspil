import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Timestamp } from "firebase/firestore";
import { DashboardTab } from "../src/pages/admin/AdminReports";
import { WorkerDashboardHeader } from "../src/components/WorkerDashboardHeader";
import { WorkerMaterialSummary } from "../src/components/WorkerMaterialSummary";
import { CustomerStatusCard } from "../src/components/CustomerStatusCard";
import type { Order, Payment } from "../src/types/domain";
import "../src/index.css";
import "../src/styles/customer-pages.css";
const now = Timestamp.now();
const order = { id:"preview",orderNumber:"#A-005",customerName:"Нұрик",customerId:"preview",materialId:"white", materialSnapshot:{name:"Ақ матовый",sheetLengthMm:2800,sheetWidthMm:2070}, productionStatus:"cutting_started", paymentStatus:"paid", priority:1, createdAt:now, updatedAt:now, totalTiyn:38400000, paidTiyn:38400000, debtTiyn:0, pvcMetersTotal:176, estimatedSheets:13, pricePublished:true, lineJobs:[{index:0,materialId:"white",materialName:"Ақ матовый",sheetQty:13,pvcMeters:176,cuttingByUid:"worker",cuttingStartedAt:now}],items:[{materialId:"white",materialName:"Ақ матовый",sheetQty:13,pvcMeters:176},{materialId:"hdf",materialName:"ХДФ",sheetQty:5,pvcMeters:0}] } as unknown as Order;
const payments = Array.from({length:7},(_,i)=>({id:String(i), amountTiyn:(i+1)*1600000, paymentDate:Timestamp.fromMillis(Date.now()-i*86400000), methodName:i%2?"Kaspi Pay":"Қолма-қол", reversed:false})) as Payment[];
function OcrSmoke(){ const [result,setResult]=useState("Тест: 600 x 450 2"); return <div><h1>OCR · жергілікті тексеру</h1><button onClick={async()=>{setResult("Жүктелуде…");try{const c=document.createElement("canvas");c.width=900;c.height=160;const ctx=c.getContext("2d")!;ctx.fillStyle="white";ctx.fillRect(0,0,900,160);ctx.fillStyle="black";ctx.font="italic 64px Georgia";ctx.fillText("600 x 450 2",35,105);const blob=await new Promise<Blob>(r=>c.toBlob(b=>r(b!),"image/png"));const {recognizeHandwriting}=await import("../src/lib/handwritingOcr");setResult(await recognizeHandwriting(blob,p=>setResult(`${p.stage} ${p.detail??""} ${Math.round((p.progress??0)*100)}%`),"accurate"));}catch(e){setResult(String(e));}}}>Base моделін тексеру</button><p role="status">{result}</p></div>; }
function Preview(){const [view,setView]=useState("queue");const panel=new URLSearchParams(location.search).get("panel");
if(panel==="ocr") return <OcrSmoke/>;
if(!panel) return <div style={{padding:20, background:"#e9edf5", minHeight:"100vh"}}><h1 style={{fontSize:20}}>Тест деректері · нақты React компоненттері</h1><div style={{display:"flex", gap:24, alignItems:"flex-start"}}>{["worker","customer","reports"].map(p=><iframe key={p} title={p} src={`?panel=${p}`} style={{flexShrink:0,width:375,height:850,border:"1px solid #ccd3df",borderRadius:16,background:"white"}} />)}</div></div>;
return <BrowserRouter><div className="app-shell" data-worker-role="raspil"><div style={{background:"#f8f9fc",minHeight:"100vh",padding:12}}><h1 style={{fontSize:22,margin:"6px 0 16px"}}>{panel==="reports"?"Есептер":panel==="worker"?"Распил":"Тапсырыс барысы"}</h1>{panel==="reports"?<><div className="report-period">{["Бүгін","Апта","Ай"].map(x=><button className={`report-period-btn ${x==="Апта"?"is-active":""}`} key={x}>{x}</button>)}</div><DashboardTab orders={[order]} payments={payments} movements={[]} materials={[]} period="week" /></>:panel==="customer"?<CustomerStatusCard order={order}/>:<><WorkerDashboardHeader queued={3} active={1} done={6} view={view} onView={setView}/><article className="station-job is-active"><span className="station-state is-active">ЖҰМЫСТА</span><button className="station-order-link">#A-005</button><div className="station-customer">Нұрик</div><WorkerMaterialSummary order={order} materials={[]} stage="cutting" uid="worker"/><button className="btn btn-primary" style={{width:"100%"}}>Распил дайын</button></article></>}</div></div></BrowserRouter>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
