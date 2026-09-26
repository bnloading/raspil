import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Timestamp } from "firebase/firestore";
import { DashboardTab } from "../src/pages/admin/AdminReports";
import { MaterialsTab } from "../src/pages/admin/AdminMaterials";
import type { Material } from "../src/types/domain";
import { WorkerDashboardHeader } from "../src/components/WorkerDashboardHeader";
import { WorkerMaterialSummary, WorkerHistorySummary } from "../src/components/WorkerMaterialSummary";
import { WorkerHistoryCard } from "../src/components/WorkerHistoryCard";
import { CustomerStatusCard } from "../src/components/CustomerStatusCard";
import { AdminPhoneSummary } from "../src/components/AdminPhoneSummary";
import type { CashboxSummary } from "../src/lib/cashbox";
import { computeOrderProfits, pvcCostKey, PVC_DEFAULT_COST_KEY } from "../src/lib/orderProfit";
import { ProfitView } from "../src/pages/admin/AdminProfit";
import { DepositCard } from "../src/components/DepositCard";
import { CashboxAccounts } from "../src/pages/manager/ManagerCashbox";
import { BottomNav } from "../src/components/layout/BottomNav";
import { getNavForRole } from "../src/components/layout/navConfig";
import type { PvcType } from "../src/types/domain";
import type { Order, Payment } from "../src/types/domain";
import "../src/index.css";
import "../src/styles/customer-pages.css";
// The station pages are dark (worker-pages.css) — without it the ПВХ panel below measures against
// a light shell the app never actually shows a worker.
import "../src/styles/worker-pages.css";
import "../src/styles/admin-pages.css";
const now = Timestamp.now();
const order = { id:"preview",orderNumber:"#A-005",customerName:"Нұрик",customerId:"preview",materialId:"white", materialSnapshot:{name:"Ақ матовый",sheetLengthMm:2800,sheetWidthMm:2070}, productionStatus:"cutting_started", paymentStatus:"paid", priority:1, createdAt:now, updatedAt:now, totalTiyn:38400000, paidTiyn:38400000, debtTiyn:0, pvcMetersTotal:176, estimatedSheets:13, pricePublished:true, lineJobs:[{index:0,materialId:"white",materialName:"Ақ матовый",sheetQty:13,pvcMeters:176,cuttingByUid:"worker",cuttingStartedAt:now}],items:[{materialId:"white",materialName:"Ақ матовый",sheetQty:13,pvcMeters:176},{materialId:"hdf",materialName:"ХДФ",sheetQty:5,pvcMeters:0}] } as unknown as Order;
const payments = Array.from({length:7},(_,i)=>({id:String(i), amountTiyn:(i+1)*1600000, paymentDate:Timestamp.fromMillis(Date.now()-i*86400000), methodName:i%2?"Kaspi Pay":"Қолма-қол", reversed:false})) as Payment[];
function OcrSmoke(){ const [result,setResult]=useState("Тест: 600 x 450 2"); return <div><h1>OCR · жергілікті тексеру</h1><button onClick={async()=>{setResult("Жүктелуде…");try{const c=document.createElement("canvas");c.width=900;c.height=160;const ctx=c.getContext("2d")!;ctx.fillStyle="white";ctx.fillRect(0,0,900,160);ctx.fillStyle="black";ctx.font="italic 64px Georgia";ctx.fillText("600 x 450 2",35,105);const blob=await new Promise<Blob>(r=>c.toBlob(b=>r(b!),"image/png"));const {recognizeHandwriting}=await import("../src/lib/handwritingOcr");setResult(await recognizeHandwriting(blob,p=>setResult(`${p.stage} ${p.detail??""} ${Math.round((p.progress??0)*100)}%`),"accurate"));}catch(e){setResult(String(e));}}}>Base моделін тексеру</button><p role="status">{result}</p></div>; }
/** A few catalogue rows, one of each case the ⋯ menu behaves differently for. */
const materials = [
  {id:"m1",name:"ЛДСП Ақ Томск",article:"AT-016",color:"Ақ",category:"ldsp",thicknessMm:16,sheetLengthMm:2750,sheetWidthMm:1830,sellingPriceTiyn:1650000,qtyOnHand:232,reservedQty:12,minStock:40,active:true},
  {id:"m2",name:"ЛДСП Кашемир",article:"KS-016",color:"Кашемир",category:"ldsp",thicknessMm:16,sheetLengthMm:2750,sheetWidthMm:1830,sellingPriceTiyn:1700000,qtyOnHand:0,reservedQty:0,minStock:10,active:true},
  {id:"m3",name:"Столешница Ақ",article:"ST-038",color:"Ақ",category:"countertop",thicknessMm:38,sheetLengthMm:3000,sheetWidthMm:600,sellingPriceTiyn:2400000,qtyOnHand:12,reservedQty:0,minStock:2,active:true},
  {id:"m4",name:"Ескі лист (қолданылмайды)",article:"",color:"",category:"ldsp",thicknessMm:16,sheetLengthMm:2750,sheetWidthMm:1830,sellingPriceTiyn:0,qtyOnHand:0,reservedQty:0,minStock:0,active:false},
] as unknown as Material[];

/** The ПВХ station, both of its views, inside the shell that carries the pvh accent. */
const pvcOrder = {...order, id:"pvc1", orderNumber:"#1042", customerName:"Алмат", productionStatus:"pvc_started", pvcMetersTotal:89,
  lineJobs:[{index:0,materialId:"white",materialName:"Ақ 0,4 мм",sheetQty:5,pvcMeters:89,pvcByUid:"worker",pvcStartedAt:now,pvcCompletedAt:now}]} as unknown as Order;
function PvcPanels(){
  return <BrowserRouter><div className="app-shell station-shell" data-worker-role="pvh"><div className="app-main"><main className="app-content narrow" style={{padding:12}}>
    <div className="station-segmented" role="tablist">
      <button className="station-segmented-btn"><span>Кезек</span><b>3</b></button>
      <button className="station-segmented-btn"><span>Жұмыста</span><b>1</b></button>
      <button className="station-segmented-btn is-active"><span>Дайын</span><b>12</b></button>
    </div>
    <article className="station-hero">
      <div className="station-hero-head">
        <div>
          <span className="station-job-eyebrow">Қазір жұмыста</span>
          <strong className="station-hero-customer">Алмат</strong>
          <button className="station-order-link">#1042</button>
        </div>
        <span className="station-state is-working">🕐 Жұмыста</span>
      </div>
      <div className="station-hero-cut is-done">✅ Распил дайын</div>
      <div className="station-hero-face">
        <span className="mthumb is-sm is-empty" />
        <span className="station-hero-face-name">Ақ • 0,4 мм</span>
        <b className="station-hero-meters">89 м</b>
      </div>
      <div className="station-hero-time">
        <span>🕐 Қалған уақыт: <b>10 мин</b></span>
        <button className="station-hero-edit">✎</button>
      </div>
      <button className="btn btn-primary station-hero-done">✓ ПВХ дайын</button>
      <button className="btn btn-outline station-hero-more">Толығырақ</button>
    </article>
    <section className="station-next">
      <div className="station-next-head"><h3>Келесі заказдар</h3><span>3 заказ</span></div>
      {[["Айбек","#1043","Дуб Вотан • 1 мм","42"],["Аружан","#1044","Кашемир • 2 мм","67"],["Нұрлан","#1045","Сұр • 0,4 мм","18"]].map(([n,c,f,m])=>(
        <button key={c} className="station-next-row">
          <span className="mthumb is-sm is-empty" />
          <span className="station-next-who"><strong>{n} · {c}</strong><small>{f}</small></span>
          <b className="station-next-meters">{m} м</b>
          <span className="station-next-chev">›</span>
        </button>))}
    </section>
    <section className="station-next is-done-section">
      <div className="station-next-head"><h3>Бүгін бітті</h3><span>1 заказ</span></div>
      <button className="station-next-row is-done">
        <span className="mthumb is-sm is-empty" />
        <span className="station-next-who"><strong>Ерасыл · #1040</strong><small>✓ Бүгін бітті</small></span>
        <b className="station-next-meters">24 м</b>
        <span className="station-next-chev">›</span>
      </button>
    </section>
    <div className="station-history-list">
      <WorkerHistoryCard order={pvcOrder} stage="pvc" uid="worker" materials={[]} to="#" />
      <WorkerHistoryCard order={{...pvcOrder, id:"pvc2", orderNumber:"#1041", customerName:"Айбек"} as Order} stage="pvc" uid="worker" materials={[]} to="#" />
    </div>
    <div className="station-day-foot"><span>Бүгін дайын</span><strong>186 м</strong></div>
  </main></div></div></BrowserRouter>;
}


/** The Admin's phone home, on the figures from the owner's Касса screenshot (all time). */
const T = (tenge: number) => tenge * 100;
const apsCashbox: CashboxSummary = { monthKey:null, totalInTiyn:T(4881960), totalOutTiyn:T(2828404), totalBalanceTiyn:T(6307347), accounts:[
  {account:"deposit", inTiyn:T(2309420), outTiyn:T(2820164), balanceTiyn:T(3743047), byMethod:[{methodId:"nur",methodName:"Нұр",amountTiyn:T(2309420)}], expenseCount:18},
  {account:"pay", inTiyn:T(1251080), outTiyn:0, balanceTiyn:T(1251080), byMethod:[{methodId:"pay",methodName:"Pay",amountTiyn:T(1051080)},{methodId:"kaspi",methodName:"Kaspi",amountTiyn:T(200000)}], expenseCount:0},
  {account:"cash", inTiyn:T(1321460), outTiyn:T(8240), balanceTiyn:T(1313220), byMethod:[{methodId:"cash",methodName:"Нал / Қолма-қол",amountTiyn:T(1321460)}], expenseCount:1},
]};
/** The Таза пайда page's view on a handful of orders since 22.09, through the real calculation. */
const at = (d: string) => Timestamp.fromDate(new Date(`${d}T12:00:00+05:00`));
const prfMaterials = [
  {id:"m1",name:"ЛДСП Ақ Томск",category:"ldsp",sellingPriceTiyn:T(16500),active:true,archived:false},
  {id:"m2",name:"ЛДСП Кашемир",category:"ldsp",sellingPriceTiyn:T(17000),active:true,archived:false},
  {id:"hdf",name:"ХДФ Ақ",category:"ldsp",sellingPriceTiyn:T(7500),active:true,archived:false},
  {id:"m3",name:"Столешница Ақ 38 мм",category:"countertop",sellingPriceTiyn:T(45000),active:true,archived:false},
  {id:"ext",name:"Сырттан келетін столешница 3м",category:"countertop",stockTracked:false,sellingPriceTiyn:0,active:true,archived:false},
  {id:"m4",name:"Столешница Кашемир 38 мм",category:"countertop",sellingPriceTiyn:T(48000),active:true,archived:false},
] as unknown as Material[];
const prfPvc = [
  {id:"p1",colorName:"Ақ",thicknessMm:0.4,pricePerMeterTiyn:T(150),active:true},
  {id:"p2",colorName:"Ақ",thicknessMm:2,pricePerMeterTiyn:T(350),active:true},
  {id:"p3",colorName:"Кашемир",thicknessMm:1,pricePerMeterTiyn:T(250),active:true},
] as unknown as PvcType[];
// The owner's own example: ЛДСП Ақ sold at 16 200, bought at 13 000. Кашемир has no wholesale yet.
const prfCosts = new Map<string, number>([["m3",T(38000)],["m1",T(13000)],["hdf",T(5200)],[pvcCostKey("p1"),T(60)],[PVC_DEFAULT_COST_KEY,T(90)]]);
const line = (materialId:string, materialName:string, sheetQty:number, price:number, pvcMeters=0, pvcPrice=0, pvcTypeId?:string) =>
  ({materialId,materialName,sheetQty,sheetPriceTiyn:T(price),pvcMeters,pvcPricePerMeterTiyn:T(pvcPrice),pvcTypeId});
const prfOrders = [
  {...order, id:"a", orderNumber:"#1046", customerName:"Айбек", productionStatus:"ready", createdAt:at("2026-09-25"), pvcByType:undefined,
    items:[line("m1","ЛДСП Ақ Томск",12,16200,120,150,"p1"), line("hdf","ХДФ Ақ",3,7500)], pvcMetersTotal:120, pvcCostTiyn:T(18000), cuttingCostTiyn:T(30000),
    discountTiyn:0, totalTiyn:T(194400+22500+18000+30000), debtTiyn:0},
  {...order, id:"b", orderNumber:"#1045", customerName:"Аружан", productionStatus:"pvc_queue", createdAt:at("2026-09-24"), pvcByType:undefined,
    items:[line("m2","ЛДСП Кашемир",9,17000,64,250,"p3")], pvcMetersTotal:64, pvcCostTiyn:T(16000), cuttingCostTiyn:T(18000),
    discountTiyn:T(5000), totalTiyn:T(153000+16000+18000-5000), debtTiyn:T(60000)},
  {...order, id:"c", orderNumber:"#1043", customerName:"Нұрлан", productionStatus:"delivered", createdAt:at("2026-09-22"), pvcByType:undefined,
    items:[line("m1","ЛДСП Ақ Томск",5,16000,40,150)], pvcMetersTotal:40, pvcCostTiyn:T(6000), cuttingCostTiyn:T(10000),
    discountTiyn:0, totalTiyn:T(80000+6000+10000), debtTiyn:0},
  {...order, id:"d", orderNumber:"#1047", customerName:"Ерлан", productionStatus:"ready", createdAt:at("2026-09-26"), pvcByType:undefined,
    items:[line("m3","Столешница Ақ 38 мм",2,45000), line("ext","Сырттан келетін столешница 3м",1,0)], pvcMetersTotal:0, pvcCostTiyn:0, cuttingCostTiyn:T(2000),
    discountTiyn:0, totalTiyn:T(90000+2000), debtTiyn:0},
  {...order, id:"old", orderNumber:"#1030", customerName:"Ескі", createdAt:at("2026-09-20"), totalTiyn:T(500000)},
] as unknown as Order[];
const prfCategories = new Map(prfMaterials.map((m) => [m.id, m.category ?? "ldsp"] as const));
const prfFree = new Set(["ext"]);
const apsProfit = computeOrderProfits({ orders: prfOrders, costs: prfCosts, categoryByMaterialId: prfCategories, freeMaterialIds: prfFree });
function ProfitPanel(){
  const [costs, setCosts] = useState(prfCosts);
  const summary = computeOrderProfits({ orders: prfOrders, costs, categoryByMaterialId: prfCategories, freeMaterialIds: prfFree });
  return <BrowserRouter><div className="app-shell"><div className="app-main"><main className="app-content" style={{padding:12,background:"var(--bg)",minHeight:"100vh"}}>
    <ProfitView header={<DepositCard now={nurCashbox.accounts[0]} month={nurCashbox.accounts[0]} monthKey="2026-09" openingTiyn={T(4253791)} startDate="2026-09-22" />}
      summary={summary} materials={prfMaterials} pvcTypes={prfPvc} costs={costs} freeMaterialIds={prfFree}
      onSavePrice={async (key, tiyn) => setCosts(prev => new Map(prev).set(key, tiyn))} onOpenOrder={() => {}} />
  </main></div></div></BrowserRouter>;
}
/** The Касса cards on the owner's latest screenshot: Нұр 4 253 791 + 2 763 520 − 3 821 804 = 3 195 507. */
const nurCashbox: CashboxSummary = { monthKey:null, totalInTiyn:T(5335680), totalOutTiyn:T(3830044), totalBalanceTiyn:T(5759427), accounts:[
  {account:"deposit", inTiyn:T(2763520), outTiyn:T(3821804), balanceTiyn:T(3195507), byMethod:[{methodId:"nur",methodName:"Нұр",amountTiyn:T(2763520)}], expenseCount:25},
  {account:"pay", inTiyn:T(1251080), outTiyn:0, balanceTiyn:T(1251080), byMethod:[{methodId:"pay",methodName:"Pay",amountTiyn:T(1051080)},{methodId:"kaspi",methodName:"Kaspi",amountTiyn:T(200000)}], expenseCount:0},
  {account:"cash", inTiyn:T(1321080), outTiyn:T(8240), balanceTiyn:T(1312840), byMethod:[{methodId:"cash",methodName:"Нал / Қолма-қол",amountTiyn:T(1321080)}], expenseCount:1},
]};
function AdminPhonePanel(){
  return <BrowserRouter><div className="app-shell"><div className="app-main"><main className="app-content" style={{padding:12,background:"var(--bg)",minHeight:"100vh"}}>
    <AdminPhoneSummary profit={apsProfit} cashbox={apsCashbox} openingBalanceTiyn={{deposit:T(4253791)}} sheetsCut={{week:221,month:221}} startDate="2026-09-18" />
  </main></div></div></BrowserRouter>;
}
function Preview(){const [view,setView]=useState("queue");const panel=new URLSearchParams(location.search).get("panel");
if(panel==="ocr") return <OcrSmoke/>;
if(panel==="pvh") return <PvcPanels/>;
if(panel==="admin") return <AdminPhonePanel/>;
if(panel==="profit") return <ProfitPanel/>;
if(panel==="nav") return <BrowserRouter><div className="app-shell"><div className="app-main" style={{minHeight:"100vh"}}><BottomNav items={getNavForRole("admin","ldsp",false)} activeKey="admin-profit" fab={{ onClick: () => {} }} /></div></div></BrowserRouter>;
if(panel==="cashbox") return <BrowserRouter><div className="app-shell"><div className="app-main"><main className="app-content" style={{padding:12,background:"var(--bg)",minHeight:"100vh"}}><CashboxAccounts cashbox={nurCashbox} cashboxNow={nurCashbox} openingBalanceTiyn={{deposit:T(4253791)}} period={null} /><div style={{height:16}}/><CashboxAccounts cashbox={{...nurCashbox, accounts: nurCashbox.accounts.map(a => ({...a, inTiyn: Math.round(a.inTiyn/3), outTiyn: Math.round(a.outTiyn/3)}))}} cashboxNow={nurCashbox} openingBalanceTiyn={{deposit:T(4253791)}} period="2026-09" /></main></div></div></BrowserRouter>;
if(panel==="materials") return <div className="app-shell"><div style={{background:"#f8f9fc",minHeight:"100vh",padding:12}}><h1 style={{fontSize:22,margin:"6px 0 16px"}}>Қойма · Материалдар</h1><MaterialsTab materials={materials} movements={[]} loading={false} canEdit onEdit={()=>{}} onLedger={()=>{}} showToast={()=>{}} /></div></div>;
if(!panel) return <div style={{padding:20, background:"#e9edf5", minHeight:"100vh"}}><h1 style={{fontSize:20}}>Тест деректері · нақты React компоненттері</h1><div style={{display:"flex", gap:24, alignItems:"flex-start"}}>{["worker","customer","reports","materials","pvh","admin","profit","cashbox"].map(p=><iframe key={p} title={p} src={`?panel=${p}`} style={{flexShrink:0,width:375,height:850,border:"1px solid #ccd3df",borderRadius:16,background:"white"}} />)}</div></div>;
return <BrowserRouter><div className="app-shell" data-worker-role="raspil"><div style={{background:"#f8f9fc",minHeight:"100vh",padding:12}}><h1 style={{fontSize:22,margin:"6px 0 16px"}}>{panel==="reports"?"Есептер":panel==="worker"?"Распил":"Тапсырыс барысы"}</h1>{panel==="reports"?<><div className="report-period">{["Бүгін","Апта","Ай"].map(x=><button className={`report-period-btn ${x==="Апта"?"is-active":""}`} key={x}>{x}</button>)}</div><DashboardTab orders={[order]} payments={payments} movements={[]} materials={[]} period="week" /></>:panel==="customer"?<CustomerStatusCard order={order}/>:<><WorkerDashboardHeader queued={3} active={1} done={6} view={view} onView={setView}/><article className="station-job is-active"><span className="station-state is-active">ЖҰМЫСТА</span><button className="station-order-link">#A-005</button><div className="station-customer">Нұрик</div><WorkerMaterialSummary order={order} materials={[]} stage="cutting" uid="worker"/><button className="btn btn-primary" style={{width:"100%"}}>Распил дайын</button></article></>}</div></div></BrowserRouter>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
