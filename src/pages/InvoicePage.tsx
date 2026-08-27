import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import { Spinner, Toast } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { InvoiceDocument } from "../components/InvoiceDocument";
import { useToast } from "../hooks";
import { useOrderDetail } from "../hooks/useOrderDetail";
import { useOrderInvoices } from "../hooks/useInvoices";
import { useOrderPayments } from "../hooks/usePayments";
import { useAppSettings } from "../hooks/useAppSettings";
import { issueInvoice, sendInvoiceToCustomer } from "../lib/invoices";
import { downloadInvoicePdf } from "../lib/invoicePdf";
import { isAdminOrManager } from "../lib/rbac";
import { formatDateTimeDMY } from "../lib/dates";

/**
 * Invoice view for one order. Admin/Manager can issue a new version and publish it to the
 * customer; a customer reaching this page sees only invoices already sent to them (enforced by
 * firestore.rules, not just by hiding the buttons).
 */
export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const { user, userData } = useAuth();
  const { order, loading } = useOrderDetail(id);
  const { invoices, loading: invoicesLoading } = useOrderInvoices(id);
  const { payments } = useOrderPayments(id);
  const { settings } = useAppSettings();
  const { message, visible, showToast } = useToast();
  const [pdfBusy, setPdfBusy] = useState(false);

  const staff = isAdminOrManager(userData?.role);
  const visible_ = useMemo(
    () => (staff ? invoices : invoices.filter((i) => i.sentToCustomer)),
    [invoices, staff],
  );
  const latest = visible_[0];

  if (loading || invoicesLoading) return <Spinner />;
  if (!user || !userData || !order) {
    return (
      <AppShell title="Накладной" back="/orders">
        <div className="empty-state">
          <div className="icon">😔</div>
          <p>Заказ табылмады</p>
        </div>
      </AppShell>
    );
  }

  const actor = { user, userData };
  const backTo = staff ? `/manager/order/${order.id}` : `/order/${order.id}`;

  const handleIssue = async () => {
    try {
      await issueInvoice(db, actor, order, payments);
      showToast("✅ Накладной жасалды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const handleDownloadPdf = async () => {
    if (!latest) return;
    setPdfBusy(true);
    try {
      // Generated on demand from the stored snapshot, so the customer's download and the
      // Manager's are byte-for-byte the same document.
      await downloadInvoicePdf(latest, settings.companyName);
      showToast("✅ PDF жүктелді");
    } catch (err: unknown) {
      showToast("PDF жасалмады: " + (err as Error).message);
    }
    setPdfBusy(false);
  };

  const handleSend = async () => {
    if (!latest) return;
    if (!order.customerId) {
      showToast("Бұл заказда клиент аккаунты жоқ — жіберу мүмкін емес");
      return;
    }
    try {
      await sendInvoiceToCustomer(db, actor, latest);
      showToast("✅ Клиентке жіберілді");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  return (
    <AppShell title={`Накладной · ${order.orderNumber}`} back={backTo} contentWidth="narrow">
      {staff && (
        <div className="wizard-actions no-print" style={{ marginBottom: 16 }}>
          <button className="btn btn-primary btn-sm" onClick={handleIssue}>
            {latest ? "🔄 Қайта жасау" : "📄 Накладной PDF жасау"}
          </button>
          {latest && (
            <button className="btn btn-outline btn-sm" disabled={pdfBusy} onClick={handleDownloadPdf}>
              {pdfBusy ? "PDF жасалуда…" : "⭳ PDF жүктеу"}
            </button>
          )}
          {latest && !latest.sentToCustomer && (
            <button className="btn btn-outline btn-sm" onClick={handleSend}>
              ✉ Клиентке жіберу
            </button>
          )}
          {latest && (
            <button className="btn btn-outline btn-sm" onClick={() => window.print()}>
              🖨 Басып шығару
            </button>
          )}
        </div>
      )}

      {!latest ? (
        <div className="empty-state">
          <div className="icon">🧾</div>
          <p>{staff ? "Накладной әлі жасалмаған" : "Накладной әлі жіберілмеген"}</p>
        </div>
      ) : (
        <>
          <InvoiceDocument invoice={latest} companyName={settings.companyName} />

          {!staff && (
            <div className="wizard-actions no-print" style={{ marginTop: 16 }}>
              {/* Regenerated from the same stored snapshot the Manager issued, so the customer
                  downloads exactly the document that was sent to them. */}
              <button className="btn btn-primary" disabled={pdfBusy} onClick={handleDownloadPdf}>
                {pdfBusy ? "PDF жасалуда…" : "⭳ PDF жүктеу"}
              </button>
              <button className="btn btn-outline" onClick={() => window.print()}>
                🖨 Басып шығару
              </button>
            </div>
          )}

          {visible_.length > 1 && (
            <section className="panel-card no-print" style={{ marginTop: 18 }}>
              <div className="panel-head">
                <h3>Нұсқа тарихы</h3>
              </div>
              <div className="data-list">
                {visible_.map((inv) => (
                  <div key={inv.id} className="data-row">
                    <div className="data-row-main">
                      <strong>
                        {inv.invoiceNumber} · нұсқа {inv.version}
                      </strong>
                      <span>
                        {inv.issuedByName}
                        {inv.issuedAt ? ` · ${formatDateTimeDMY(inv.issuedAt)}` : ""}
                      </span>
                    </div>
                    <div className="data-row-actions">
                      <span className={`jt-pill jt-tone-${inv.sentToCustomer ? "green" : "muted"}`}>
                        {inv.sentToCustomer ? "Жіберілді" : "Жіберілмеген"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
