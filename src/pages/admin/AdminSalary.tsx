import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { MoneyInput } from "../../components/MoneyInput";
import { useToast } from "../../hooks";
import { useAllOrders } from "../../hooks/useOrders";
import { useMaterials } from "../../hooks/useMaterials";
import { useAllSalaryRules, useAttendance, useSalaryAdjustments, useSalaryEntries } from "../../hooks/useSalary";
import { addSalaryAdjustment, recalculateSalary, saveSalaryRule, setSalaryStatus } from "../../lib/salaryWrite";
import { availablePeriods } from "../../lib/salary";
import { formatMoney } from "../../lib/money";
import { monthKey, monthLabel } from "../../lib/dates";
import { ROLE_LABELS } from "../../lib/rbac";
import {
  SALARY_MODE_LABELS,
  SALARY_STATUS_LABELS,
  type SalaryMode,
  type SalaryRule,
  type UserDoc,
} from "../../types/domain";

interface StaffUser extends UserDoc {
  id: string;
}

const MODES: SalaryMode[] = ["MANUAL", "FIXED_MONTHLY", "PER_SHEET", "PER_PVC_METER", "PER_ORDER", "HOURLY", "MIXED"];
const STATUS_TONE: Record<string, string> = {
  calculating: "muted",
  calculated: "blue",
  confirmed: "amber",
  paid: "green",
};

/**
 * Admin salary management: configure each worker's rule, recalculate a month from measured work,
 * and move entries through calculated → confirmed → paid. The default mode stays MANUAL until a
 * real formula is configured, so nothing is ever invented on the worker's behalf.
 */
export default function AdminSalary() {
  const { user, userData } = useAuth();
  const { orders } = useAllOrders();
  const { materials } = useMaterials(false);
  const { records: attendance } = useAttendance();
  const { rules } = useAllSalaryRules();
  const { entries } = useSalaryEntries();
  const { adjustments } = useSalaryAdjustments();
  const { message, visible, showToast } = useToast();

  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [period, setPeriod] = useState(monthKey(new Date()));
  const [busy, setBusy] = useState(false);
  const [editRuleFor, setEditRuleFor] = useState<string | null>(null);

  useEffect(() => {
    getDocs(query(collection(db, "users"), where("role", "in", ["manager", "raspil", "pvh"])))
      .then((snap) => setStaff(snap.docs.map((d) => ({ id: d.id, ...(d.data() as UserDoc) }))))
      .catch(() => setStaff([]));
  }, []);

  const periods = useMemo(() => availablePeriods(orders, attendance), [orders, attendance]);
  // Piece rates differ per category, so recalculation needs to know what each sheet was.
  const categoryByMaterialId = useMemo(
    () => new Map(materials.map((m) => [m.id, m.category ?? "ldsp"] as const)),
    [materials],
  );
  const rulesByUid = useMemo(() => new Map(rules.map((r) => [r.userId, r])), [rules]);
  const entryFor = (uid: string) => entries.find((e) => e.userId === uid && e.periodKey === period);
  const adjustmentTotal = (uid: string) =>
    adjustments.filter((a) => a.userId === uid && a.periodKey === period).reduce((s, a) => s + a.amountTiyn, 0);

  const totals = useMemo(() => {
    const periodEntries = entries.filter((e) => e.periodKey === period);
    return {
      total: periodEntries.reduce((s, e) => s + e.finalTiyn, 0),
      paid: periodEntries.filter((e) => e.status === "paid").reduce((s, e) => s + e.finalTiyn, 0),
      count: periodEntries.length,
    };
  }, [entries, period]);

  if (!user || !userData) return <Spinner />;
  const actor = { user, userData };

  const handleRecalculate = async (member: StaffUser) => {
    setBusy(true);
    try {
      await recalculateSalary(db, actor, {
        userId: member.id,
        userName: member.name,
        periodKey: period,
        rule: rulesByUid.get(member.id),
        orders,
        attendance,
        categoryByMaterialId,
        adjustmentTiyn: adjustmentTotal(member.id),
        existing: entryFor(member.id),
      });
      showToast(`✅ ${member.name}: айлық есептелді`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setBusy(false);
  };

  const handleAdjust = async (member: StaffUser) => {
    const raw = prompt(`${member.name} — түзету сомасы (₸, теріс сан да болады):`);
    if (raw === null) return;
    const amountTiyn = Math.round((parseFloat(raw.replace(",", ".")) || 0) * 100);
    if (amountTiyn === 0) {
      showToast("Сома нөл болмауы керек");
      return;
    }
    const reason = prompt("Түзету себебі (міндетті):");
    if (!reason || !reason.trim()) {
      showToast("Себепсіз түзету енгізілмейді");
      return;
    }
    setBusy(true);
    try {
      await addSalaryAdjustment(db, actor, { userId: member.id, periodKey: period, amountTiyn, reason });
      showToast("✅ Түзету қосылды. Қайта есептеңіз.");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setBusy(false);
  };

  const handleStatus = async (member: StaffUser, status: "confirmed" | "paid") => {
    const entry = entryFor(member.id);
    if (!entry) return;
    if (status === "paid" && !confirm(`${member.name}: ${formatMoney(entry.finalTiyn)} төленді деп белгілейсіз бе?`)) {
      return;
    }
    setBusy(true);
    try {
      await setSalaryStatus(db, actor, entry, status);
      showToast(`✅ ${SALARY_STATUS_LABELS[status]}`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setBusy(false);
  };

  return (
    <AppShell title="Айлық" subtitle={monthLabel(period)}>
      <div className="form-group" style={{ maxWidth: 260 }}>
        <label>Есептік кезең</label>
        <select className="form-input" value={period} onChange={(e) => setPeriod(e.target.value)}>
          {periods.map((p) => (
            <option key={p} value={p}>
              {monthLabel(p)}
            </option>
          ))}
        </select>
      </div>

      <div className="stats-bar">
        <div className="stat-card">
          <div className="number">{formatMoney(totals.total)}</div>
          <div className="label">Жалпы есептелген</div>
        </div>
        <div className="stat-card">
          <div className="number">{formatMoney(totals.paid)}</div>
          <div className="label">Төленген</div>
        </div>
        <div className="stat-card">
          <div className="number">{totals.count}</div>
          <div className="label">Есептелген қызметкер</div>
        </div>
      </div>

      {staff.length === 0 ? (
        <div className="empty-state">
          <div className="icon">👥</div>
          <p>Қызметкер жоқ</p>
        </div>
      ) : (
        staff.map((member) => {
          const rule = rulesByUid.get(member.id);
          const entry = entryFor(member.id);
          const adj = adjustmentTotal(member.id);
          return (
            <section key={member.id} className="panel-card salary-card">
              <div className="panel-head">
                <h3>
                  {member.name} <span className="jt-muted">· {ROLE_LABELS[member.role]}</span>
                </h3>
                <span className="jt-pill jt-tone-muted">{SALARY_MODE_LABELS[rule?.mode ?? "MANUAL"]}</span>
              </div>

              {entry ? (
                <div className="salary-summary-row">
                  <div>
                    <span className="worker-field-label">Негізгі</span>
                    <strong>{formatMoney(entry.baseTiyn)}</strong>
                  </div>
                  <div>
                    <span className="worker-field-label">Түзету</span>
                    <strong>{formatMoney(entry.adjustmentTiyn)}</strong>
                  </div>
                  <div>
                    <span className="worker-field-label">Ұстама</span>
                    <strong>{formatMoney(entry.deductionTiyn)}</strong>
                  </div>
                  <div>
                    <span className="worker-field-label">Қорытынды</span>
                    <strong className="salary-final">{formatMoney(entry.finalTiyn)}</strong>
                  </div>
                  <div>
                    <span className="worker-field-label">Күйі</span>
                    <span className={`jt-pill jt-tone-${STATUS_TONE[entry.status] ?? "muted"}`}>
                      {SALARY_STATUS_LABELS[entry.status]}
                    </span>
                  </div>
                </div>
              ) : (
                <p className="jt-muted" style={{ margin: "0 0 12px" }}>
                  Бұл айға әлі есептелмеген
                  {adj !== 0 ? ` · түзету: ${formatMoney(adj)}` : ""}
                </p>
              )}

              {entry && (
                <div className="salary-work-row">
                  <span>Лист: {entry.sheetsCut}{entry.hdfSheets || entry.countertopSheets ? ` (ЛДСП ${entry.ldspSheets ?? 0} · ХДФ ${entry.hdfSheets ?? 0} · Столешница ${entry.countertopSheets ?? 0})` : ""}</span>
                  <span>ПВХ: {entry.pvcMeters.toFixed(1)} м</span>
                  <span>Заказ: {entry.ordersCompleted}</span>
                  <span>Күн: {entry.presentDays}</span>
                  <span>Сағат: {entry.workedHours.toFixed(1)}</span>
                </div>
              )}

              <div className="wizard-actions">
                <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => handleRecalculate(member)}>
                  🧮 Қайта есептеу
                </button>
                <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => handleAdjust(member)}>
                  ± Түзету
                </button>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => setEditRuleFor(editRuleFor === member.id ? null : member.id)}
                >
                  ⚙ Ереже
                </button>
                {entry?.status === "calculated" && (
                  <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => handleStatus(member, "confirmed")}>
                    ✓ Растау
                  </button>
                )}
                {entry?.status === "confirmed" && (
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => handleStatus(member, "paid")}>
                    💰 Төленді
                  </button>
                )}
              </div>

              {editRuleFor === member.id && (
                <SalaryRuleEditor
                  rule={rule}
                  busy={busy}
                  onSave={async (next) => {
                    setBusy(true);
                    try {
                      await saveSalaryRule(db, actor, member.id, next);
                      showToast("✅ Ереже сақталды");
                      setEditRuleFor(null);
                    } catch (err: unknown) {
                      showToast("Қате: " + (err as Error).message);
                    }
                    setBusy(false);
                  }}
                />
              )}
            </section>
          );
        })
      )}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}

type RuleDraft = Omit<SalaryRule, "id" | "userId" | "updatedAt" | "updatedByUid" | "updatedByName">;

function SalaryRuleEditor({
  rule,
  busy,
  onSave,
}: {
  rule: SalaryRule | undefined;
  busy: boolean;
  onSave: (rule: RuleDraft) => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>({
    mode: rule?.mode ?? "MANUAL",
    fixedMonthlyTiyn: rule?.fixedMonthlyTiyn ?? 0,
    perSheetTiyn: rule?.perSheetTiyn ?? 0,
    perHdfSheetTiyn: rule?.perHdfSheetTiyn ?? 0,
    perCountertopTiyn: rule?.perCountertopTiyn ?? 0,
    perPvcMeterTiyn: rule?.perPvcMeterTiyn ?? 0,
    perOrderTiyn: rule?.perOrderTiyn ?? 0,
    hourlyTiyn: rule?.hourlyTiyn ?? 0,
    absentDayDeductionTiyn: rule?.absentDayDeductionTiyn ?? 0,
  });

  const patch = (p: Partial<RuleDraft>) => setDraft({ ...draft, ...p });
  const isManual = draft.mode === "MANUAL";

  return (
    <div className="salary-rule-editor">
      <div className="form-group">
        <label>Есептеу тәртібі</label>
        <select className="form-input" value={draft.mode} onChange={(e) => patch({ mode: e.target.value as SalaryMode })}>
          {MODES.map((m) => (
            <option key={m} value={m}>
              {SALARY_MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </div>

      {isManual ? (
        <p className="jt-muted" style={{ margin: "0 0 12px", fontSize: "0.82rem" }}>
          Қолмен режимде негізгі сома 0 болады — соңғы соманы «± Түзету» арқылы енгізесіз.
        </p>
      ) : (
        <div className="form-grid">
          {(draft.mode === "FIXED_MONTHLY" || draft.mode === "MIXED") && (
            <div className="form-group">
              <label>Айлық бекітілген (₸)</label>
              <MoneyInput valueTiyn={draft.fixedMonthlyTiyn ?? 0} onChange={(v) => patch({ fixedMonthlyTiyn: v })} />
            </div>
          )}
          {(draft.mode === "PER_SHEET" || draft.mode === "MIXED") && (
            <div className="form-group">
              <label>Лист үшін (₸)</label>
              <MoneyInput valueTiyn={draft.perSheetTiyn ?? 0} onChange={(v) => patch({ perSheetTiyn: v })} />
            </div>
          )}
          {(draft.mode === "PER_PVC_METER" || draft.mode === "MIXED") && (
            <div className="form-group">
              <label>ПВХ метрі үшін (₸)</label>
              <MoneyInput valueTiyn={draft.perPvcMeterTiyn ?? 0} onChange={(v) => patch({ perPvcMeterTiyn: v })} />
            </div>
          )}
          {(draft.mode === "PER_ORDER" || draft.mode === "MIXED") && (
            <div className="form-group">
              <label>Заказ үшін (₸)</label>
              <MoneyInput valueTiyn={draft.perOrderTiyn ?? 0} onChange={(v) => patch({ perOrderTiyn: v })} />
            </div>
          )}
          {(draft.mode === "HOURLY" || draft.mode === "MIXED") && (
            <div className="form-group">
              <label>Сағаттық (₸)</label>
              <MoneyInput valueTiyn={draft.hourlyTiyn ?? 0} onChange={(v) => patch({ hourlyTiyn: v })} />
            </div>
          )}
          <div className="form-group">
            <label>Келмеген күн ұстамасы (₸)</label>
            <MoneyInput
              valueTiyn={draft.absentDayDeductionTiyn ?? 0}
              onChange={(v) => patch({ absentDayDeductionTiyn: v })}
            />
          </div>
        </div>
      )}

      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => onSave(draft)}>
        Сақтау
      </button>
    </div>
  );
}
