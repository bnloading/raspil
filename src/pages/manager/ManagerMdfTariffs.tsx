import { useEffect, useMemo, useState } from "react";
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { NumberField } from "../../components/NumberField";
import { useToast } from "../../hooks";
import { useStaff, type StaffMember } from "../../hooks/useStaff";
import { logAudit } from "../../lib/audit";
import { formatMoney } from "../../lib/money";
import { ROLE_TO_MDF_STAGE } from "../../lib/rbac";
import { MDF_STAGES, MDF_STAGE_LABELS } from "../../types/domain";
import type { MdfStage, SalaryRule } from "../../types/domain";

/** One МДФ station worker as the page edits them, rates in tenge. */
interface WorkerDraft {
  rateTenge: number;
  packagingTenge: number;
}

/** One client paid at rates of their own — «Динко» — with a rate per worker; 0 is "the usual rate". */
interface ClientDraft {
  key: string;
  name: string;
  ratesTenge: Record<string, number>;
}

const stageOf = (member: StaffMember): MdfStage | undefined => ROLE_TO_MDF_STAGE[member.role];
const tenge = (tiyn: number | undefined) => (tiyn ?? 0) / 100;
const tiyn = (tenge: number) => Math.round(tenge * 100);

/**
 * «МДФ тарифтері» — what each МДФ station is paid per m², written by the МДФ manager (the owner,
 * 28.10: «Ахжол МДФ жұмысшыларының м² ақшасын жазатын бет»), and the clients paid at a rate of
 * their own — «Вакуум 2 200 алса, Динкоға 2 000».
 *
 * The rates are each worker's own pay rule (salaryRules), the same document the Admin's Айлық page
 * edits, so there is one rate and both pages show it. firestore.rules lets the МДФ manager change
 * only these fields, only for a ЧПУ / Шкурка / Краска / Вакуум worker. A client's rate applies to
 * every order whose customer's name contains the client's name (lib/salary.ts mdfClientOf).
 */
export default function ManagerMdfTariffs() {
  const { user, userData } = useAuth();
  const { staff, loading: staffLoading } = useStaff();
  const { message, visible, showToast } = useToast();
  const workers = useMemo(
    () => staff
      .filter((s) => !s.blocked && stageOf(s))
      .sort((a, b) => MDF_STAGES.indexOf(stageOf(a)!) - MDF_STAGES.indexOf(stageOf(b)!) || a.name.localeCompare(b.name, "kk")),
    [staff],
  );
  const [rules, setRules] = useState<Map<string, SalaryRule | null> | null>(null);
  const [drafts, setDrafts] = useState<Record<string, WorkerDraft>>({});
  const [clients, setClients] = useState<ClientDraft[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (staffLoading) return;
    let cancelled = false;
    Promise.all(
      workers.map(async (w) => {
        const snap = await getDoc(doc(db, "salaryRules", w.id));
        return [w.id, snap.exists() ? ({ id: snap.id, ...(snap.data() as Omit<SalaryRule, "id">) }) : null] as const;
      }),
    )
      .then((pairs) => {
        if (cancelled) return;
        const loaded = new Map(pairs);
        setRules(loaded);
        setDrafts(Object.fromEntries(workers.map((w) => [w.id, {
          rateTenge: tenge(loaded.get(w.id)?.perMdfM2Tiyn),
          packagingTenge: tenge(loaded.get(w.id)?.perPackagingOrderTiyn),
        }])));
        // Every client any station has a rate for, each with its rate per worker.
        const names = [...new Set(workers.flatMap((w) => Object.keys(loaded.get(w.id)?.perMdfM2ByClientTiyn ?? {})))];
        setClients(names.map((name) => ({
          key: crypto.randomUUID(),
          name,
          ratesTenge: Object.fromEntries(workers.map((w) => [w.id, tenge(loaded.get(w.id)?.perMdfM2ByClientTiyn?.[name])])),
        })));
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRules(new Map());
          showToast("Тарифтер оқылмады: " + (err as Error).message);
        }
      });
    return () => {
      cancelled = true;
    };
    // showToast is stable enough for a one-off error; the list is what the load follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staffLoading, workers]);

  /** What each worker's rule would say after saving — the client rates folded back per worker. */
  const nextFor = (workerId: string) => {
    const draft = drafts[workerId] ?? { rateTenge: 0, packagingTenge: 0 };
    const byClient = Object.fromEntries(
      clients
        .filter((c) => c.name.trim() && (c.ratesTenge[workerId] ?? 0) > 0)
        .map((c) => [c.name.trim(), tiyn(c.ratesTenge[workerId])]),
    );
    return { perMdfM2Tiyn: tiyn(draft.rateTenge), perPackagingOrderTiyn: tiyn(draft.packagingTenge), perMdfM2ByClientTiyn: byClient };
  };

  const problem = (() => {
    const seen = new Set<string>();
    for (const c of clients) {
      const key = c.name.trim().toLowerCase();
      const anyRate = Object.values(c.ratesTenge).some((r) => r > 0);
      if (!key && anyRate) return "Клиенттің атын жазыңыз";
      if (key && seen.has(key)) return `«${c.name.trim()}» екі рет жазылған`;
      if (key) seen.add(key);
    }
    return null;
  })();

  if (!user || !userData) return <Spinner />;
  const actor = { user, userData };

  const save = async () => {
    if (!rules || problem) return;
    setSaving(true);
    let changed = 0;
    try {
      for (const w of workers) {
        const before = rules.get(w.id) ?? null;
        const next = nextFor(w.id);
        const stamp = { updatedAt: serverTimestamp(), updatedByUid: user.uid, updatedByName: userData.name };
        const sameClients = JSON.stringify(before?.perMdfM2ByClientTiyn ?? {}) === JSON.stringify(next.perMdfM2ByClientTiyn);
        const patch: Record<string, unknown> = {};
        if ((before?.perMdfM2Tiyn ?? 0) !== next.perMdfM2Tiyn) patch.perMdfM2Tiyn = next.perMdfM2Tiyn;
        if (stageOf(w) === "vacuum" && (before?.perPackagingOrderTiyn ?? 0) !== next.perPackagingOrderTiyn) {
          patch.perPackagingOrderTiyn = next.perPackagingOrderTiyn;
        }
        if (!sameClients) patch.perMdfM2ByClientTiyn = next.perMdfM2ByClientTiyn;
        if (Object.keys(patch).length === 0) continue;
        if (!before) {
          await setDoc(doc(db, "salaryRules", w.id), { userId: w.id, mode: "PER_MDF_M2", ...patch, ...stamp });
        } else {
          // A worker with no formula yet starts being paid by the m²; any other mode is the Admin's.
          if (!before.mode || before.mode === "MANUAL") patch.mode = "PER_MDF_M2";
          await updateDoc(doc(db, "salaryRules", w.id), { ...patch, ...stamp });
        }
        await logAudit(db, actor, {
          action: "salary.mdf_tariff",
          entityType: "salaryRule",
          entityId: w.id,
          before: {
            perMdfM2Tiyn: before?.perMdfM2Tiyn ?? 0,
            perMdfM2ByClientTiyn: before?.perMdfM2ByClientTiyn ?? {},
            perPackagingOrderTiyn: before?.perPackagingOrderTiyn ?? 0,
          },
          after: patch,
          comment: w.name,
        });
        changed += 1;
      }
      // Re-read what was written, so the page shows the stored rates and the next save diffs from them.
      const reread = new Map(rules);
      for (const w of workers) {
        const snap = await getDoc(doc(db, "salaryRules", w.id));
        reread.set(w.id, snap.exists() ? ({ id: snap.id, ...(snap.data() as Omit<SalaryRule, "id">) }) : null);
      }
      setRules(reread);
      showToast(changed > 0 ? `✅ Тарифтер сақталды (${changed} жұмысшы)` : "Өзгеріс жоқ");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setSaving(false);
  };

  const patchWorker = (id: string, change: Partial<WorkerDraft>) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { rateTenge: 0, packagingTenge: 0 }), ...change } }));
  const patchClient = (key: string, change: Partial<ClientDraft>) =>
    setClients((prev) => prev.map((c) => (c.key === key ? { ...c, ...change } : c)));

  const loading = staffLoading || rules === null;

  return (
    <AppShell title="МДФ тарифтері" subtitle="1 м² үшін жұмысшыларға төленетін ақы">
      {loading ? (
        <Spinner />
      ) : workers.length === 0 ? (
        <div className="empty-state">
          <div className="icon">👥</div>
          <p>МДФ жұмысшылары жоқ</p>
        </div>
      ) : (
        <>
          <section className="panel-card">
            <div className="panel-head">
              <h3>1 м² тарифі</h3>
            </div>
            <div className="data-table-wrap">
              <table className="data-table stack-mobile stack-compact">
                <thead>
                  <tr>
                    <th>Жұмысшы</th>
                    <th>Кезең</th>
                    <th className="num">1 м² (₸)</th>
                    <th className="num">Упаковка (₸ / заказ)</th>
                  </tr>
                </thead>
                <tbody>
                  {workers.map((w) => {
                    const mode = rules?.get(w.id)?.mode;
                    const off = mode && mode !== "MANUAL" && mode !== "PER_MDF_M2" && mode !== "MIXED";
                    return (
                      <tr key={w.id}>
                        <td data-label="Жұмысшы">
                          <strong>{w.name}</strong>
                          {off && <div className="wh-sub">Айлығы басқаша есептеледі — тарифті админ қосады</div>}
                        </td>
                        <td data-label="Кезең" className="wh-sub">{MDF_STAGE_LABELS[stageOf(w)!]}</td>
                        <td className="num" data-label="1 м² (₸)">
                          <NumberField value={drafts[w.id]?.rateTenge ?? 0} min={0} ariaLabel={`${w.name} — 1 м²`}
                            onChange={(v) => patchWorker(w.id, { rateTenge: v })} />
                        </td>
                        <td className="num" data-label="Упаковка (₸ / заказ)">
                          {stageOf(w) === "vacuum" ? (
                            <NumberField value={drafts[w.id]?.packagingTenge ?? 0} min={0} ariaLabel={`${w.name} — упаковка`}
                              onChange={(v) => patchWorker(w.id, { packagingTenge: v })} />
                          ) : (
                            <span className="jt-muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel-card">
            <div className="panel-head">
              <h3>Клиентке бөлек тариф</h3>
            </div>
            <p className="form-hint">
              Мысалы, Динко: Вакуум 2 000 ₸ — басқа клиенттерге 2 200 ₸. Клиенттің аты заказдағы атында
              кездессе («Ерасыл Динко» де), сол заказ осы тарифпен есептеледі. Бос қалса — жалпы тариф.
            </p>
            {clients.map((c) => (
              <div key={c.key} className="mdf-client-tariff">
                <div className="mdf-client-head">
                  <input className="form-input" value={c.name} placeholder="Клиент аты, мысалы Динко"
                    aria-label="Клиент аты" onChange={(e) => patchClient(c.key, { name: e.target.value })} />
                  <button type="button" className="btn btn-outline btn-sm" aria-label="Клиентті өшіру"
                    onClick={() => setClients((prev) => prev.filter((x) => x.key !== c.key))}>✕</button>
                </div>
                <div className="mdf-client-rates">
                  {workers.map((w) => (
                    <label key={w.id} className="mdf-client-rate">
                      <span>{MDF_STAGE_LABELS[stageOf(w)!]} · {w.name}</span>
                      <NumberField value={c.ratesTenge[w.id] ?? 0} min={0}
                        placeholder={drafts[w.id]?.rateTenge ? formatMoney(tiyn(drafts[w.id].rateTenge)) : "—"}
                        ariaLabel={`${c.name || "Клиент"} — ${w.name}`}
                        onChange={(v) => patchClient(c.key, { ratesTenge: { ...c.ratesTenge, [w.id]: v } })} />
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <button type="button" className="btn btn-outline btn-sm"
              onClick={() => setClients((prev) => [...prev, { key: crypto.randomUUID(), name: "", ratesTenge: {} }])}>
              + Клиент қосу
            </button>
          </section>

          {problem && <p className="form-hint">{problem}</p>}
          <p className="form-hint">
            Тариф өзгерсе, әлі расталмаған айлық та жаңа тарифпен есептеледі.
          </p>
          <button type="button" className="btn btn-primary btn-full" disabled={saving || !!problem} onClick={save}>
            {saving ? "Сақталуда…" : "Сақтау"}
          </button>
        </>
      )}
      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
