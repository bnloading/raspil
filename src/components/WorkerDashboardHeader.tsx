import type { ReactNode } from "react";

export function WorkerDashboardHeader({ queued, active, done, view, onView, historyInNav = false, children }: {
  queued: number; active: number; done: number; view: string; onView: (view: string) => void;
  historyInNav?: boolean;
  /** Under today's figures, above the tabs — the cutter's week (CutterDashboard). */
  children?: ReactNode;
}) {
  return <>
    <div className="station-stats" aria-label="Бүгінгі жұмыс">
      <div><span>Кезекте</span><strong>{queued}</strong></div>
      <div><span>Жұмыста</span><strong>{active}</strong></div>
      <div><span>Бүгін дайын</span><strong>{done}</strong></div>
    </div>
    {children}
    <div className="station-tabs" aria-label="Тапсырмалар сүзгісі">
      <button type="button" aria-pressed={view === "queue"} onClick={() => onView("queue")}>Кезек</button>
      <button type="button" aria-pressed={view === "mine"} onClick={() => onView("mine")}>Менің жұмысым</button>
      {!historyInNav && <button type="button" aria-pressed={view === "history"} onClick={() => onView("history")}>Тарих</button>}
    </div>
  </>;
}
