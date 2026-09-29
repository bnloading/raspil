import { formatMoney } from "../lib/money";
import { formatDateTimeDMY } from "../lib/dates";
import { formatPhone } from "../lib/phone";
import type { Invoice } from "../types/domain";

/**
 * The printable "Накладной". Wrapped in .print-area so the existing print stylesheet hides all
 * app chrome and prints just this sheet — the browser's own "Save as PDF" then produces the PDF,
 * which keeps Kazakh Cyrillic rendering correct (see README's invoice limitation note).
 */
export function InvoiceDocument({ invoice, companyName }: { invoice: Invoice; companyName: string }) {
  return (
    <div className="invoice-doc print-area">
      <div className="invoice-head">
        <div>
          <div className="invoice-company">{companyName}</div>
          <div className="invoice-muted">Жиһаз бөлшектерін кесу цехы</div>
        </div>
        <div className="invoice-head-right">
          <div className="invoice-title">НАКЛАДНОЙ</div>
          <div className="invoice-muted">№ {invoice.invoiceNumber}</div>
          {invoice.version > 1 && <div className="invoice-muted">Нұсқа: {invoice.version}</div>}
        </div>
      </div>

      <div className="invoice-meta">
        <div>
          <span className="invoice-muted">Заказ</span>
          <strong>{invoice.orderNumber}</strong>
        </div>
        <div>
          <span className="invoice-muted">Күні</span>
          <strong>{invoice.issuedAt ? formatDateTimeDMY(invoice.issuedAt) : "—"}</strong>
        </div>
        <div>
          <span className="invoice-muted">Клиент</span>
          <strong>{invoice.customerName}</strong>
        </div>
        <div>
          <span className="invoice-muted">Телефон</span>
          <strong>{invoice.customerPhone ? formatPhone(invoice.customerPhone) : "—"}</strong>
        </div>
      </div>

      {/* On a phone the № and Бірлік columns fold away and the unit rides in Саны ("2 лист"):
          six columns of a journal row's worth of lines ran 47px past a 390px screen. */}
      <table className="invoice-table">
        <thead>
          <tr>
            <th className="invoice-col-no">№</th>
            <th>Атауы</th>
            <th className="jt-num">Саны</th>
            <th className="invoice-col-unit">Бірлік</th>
            <th className="jt-num">Бағасы</th>
            <th className="jt-num">Сомасы</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line, i) => (
            <tr key={`${line.name}-${i}`}>
              <td className="invoice-col-no">{i + 1}</td>
              <td>{line.name}</td>
              <td className="jt-num">
                {line.qty.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}
                <span className="invoice-unit-inline"> {line.unit}</span>
              </td>
              <td className="invoice-col-unit">{line.unit}</td>
              <td className="jt-num invoice-money">{formatMoney(line.unitPriceTiyn)}</td>
              <td className="jt-num invoice-money">{formatMoney(line.totalTiyn)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="invoice-totals">
        <div>
          <span>Аралық сома</span>
          <strong>{formatMoney(invoice.subtotalTiyn)}</strong>
        </div>
        {invoice.discountTiyn > 0 && (
          <div>
            <span>Жеңілдік</span>
            <strong>−{formatMoney(invoice.discountTiyn)}</strong>
          </div>
        )}
        <div className="invoice-grand">
          <span>Жалпы сома</span>
          <strong>{formatMoney(invoice.totalTiyn)}</strong>
        </div>
        <div>
          <span>Төленді</span>
          <strong>{formatMoney(invoice.paidTiyn)}</strong>
        </div>
        <div className={invoice.debtTiyn > 0 ? "invoice-debt" : ""}>
          <span>Қарыз</span>
          <strong>{formatMoney(invoice.debtTiyn)}</strong>
        </div>
      </div>

      {invoice.paymentMethods.length > 0 && (
        <div className="invoice-methods">
          <span className="invoice-muted">Төлем әдісі: </span>
          {invoice.paymentMethods.join(", ")}
        </div>
      )}

      {invoice.note && <div className="invoice-note">{invoice.note}</div>}

      <div className="invoice-footer">
        <div>
          <span className="invoice-muted">Менеджер</span>
          <strong>{invoice.issuedByName}</strong>
        </div>
        <div className="invoice-sign">
          <span className="invoice-muted">Қолы</span>
          <span className="invoice-sign-line" />
        </div>
      </div>
    </div>
  );
}
