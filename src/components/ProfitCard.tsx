import { Link } from "react-router-dom";
import { formatMoney } from "../lib/money";
import { formatMeters, formatStartDate, signedMoney } from "../lib/orderProfit";
import type { ProfitSummary } from "../lib/orderProfit";

/**
 * "Таза пайда" and the sum that makes it — the orders' price, less the sheets and the ПВХ at
 * wholesale (lib/orderProfit.ts). The same card on the owner's phone home and on the Таза пайда
 * page, so the two can never show different numbers under one name.
 */
export function ProfitCard({
  summary,
  link = false,
  onFixPrices,
}: {
  summary: ProfitSummary;
  /** On the home screen: a way through to the page with the orders and the prices. */
  link?: boolean;
  /** On the Таза пайда page: opens the price list from the "no price" warning. */
  onFixPrices?: () => void;
}) {
  const missing = [
    summary.uncostedSheets > 0 ? `${summary.uncostedSheets} листтің` : "",
    summary.uncostedCountertops > 0 ? `${summary.uncostedCountertops} столешницаның` : "",
    summary.uncostedPvcMeters > 0 ? `${formatMeters(summary.uncostedPvcMeters)} ПВХ-ның` : "",
  ].filter(Boolean).join(", ");

  return (
    <section className="aps-card aps-profit" aria-labelledby="aps-profit-title">
      <div className="aps-head">
        <h2 id="aps-profit-title">Таза пайда</h2>
        <span>{formatStartDate(summary.startDate)} бастап</span>
      </div>
      <strong className={`aps-big${summary.profitTiyn < 0 ? " is-negative" : ""}`}>
        {formatMoney(summary.profitTiyn)}
      </strong>
      <p className="aps-sub">
        {summary.orders.length} заказ · сомасы {formatMoney(summary.revenueTiyn)}
      </p>
      {/* Where it came from, each line sale − wholesale; the Таза пайда page opens every one of
          them up into "16 200 − 13 000 = 3 200 ₸ × 45 лист". */}
      <dl className="aps-receipt">
        <div>
          <dt>Листтан пайда</dt>
          <dd>{signedMoney(summary.sheetProfitTiyn)}</dd>
        </div>
        {summary.materials.some((m) => m.countertop) && (
          <div>
            <dt>Столешницадан пайда</dt>
            <dd>{signedMoney(summary.countertopProfitTiyn)}</dd>
          </div>
        )}
        <div>
          <dt>ПВХ-дан пайда</dt>
          <dd>{signedMoney(summary.pvcProfitTiyn)}</dd>
        </div>
        {summary.cuttingTiyn !== 0 && (
          <div>
            <dt>Распил</dt>
            <dd>{signedMoney(summary.cuttingTiyn)}</dd>
          </div>
        )}
        {summary.otherTiyn !== 0 && (
          <div>
            <dt>ХДФ, қызмет, жеткізу, жеңілдік</dt>
            <dd>{signedMoney(summary.otherTiyn)}</dd>
          </div>
        )}
        <div className="is-total">
          <dt>= Таза пайда</dt>
          <dd>{formatMoney(summary.profitTiyn)}</dd>
        </div>
      </dl>
      {missing && (
        <p className="aps-note is-warn">
          {missing} оптом бағасы енгізілмеген: олар 0 ₸ болып есептелді, сондықтан пайда шын мәнінен жоғары.
          {onFixPrices && (
            <>
              {" "}
              <button type="button" className="aps-note-action" onClick={onFixPrices}>Бағаны енгізу →</button>
            </>
          )}
        </p>
      )}
      {/* Billed, not collected: an order cut on credit is profit the day it is written. */}
      {summary.debtTiyn > 0 && (
        <p className="aps-note">
          Оның <b>{formatMoney(summary.debtTiyn)}</b> — клиенттердің әлі төлемеген қарызы. Қағазда бар, қолға әлі
          тимеген.
        </p>
      )}
      {link && <Link to="/admin/profit" className="aps-more">Әр лист, ПВХ және оптом бағалар →</Link>}
    </section>
  );
}
