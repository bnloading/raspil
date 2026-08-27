import notoRegularUrl from "../assets/fonts/NotoSans-Regular.ttf?url";
import notoBoldUrl from "../assets/fonts/NotoSans-Bold.ttf?url";
import { formatMoney } from "./money";
import { formatDateTimeDMY } from "./dates";
import { formatPhone } from "./phone";
import type { Invoice } from "../types/domain";

/**
 * Real downloadable PDF generation for the "Накладной".
 *
 * pdfmake's bundled fonts are Latin-only, so a Cyrillic-capable face is registered explicitly:
 * Noto Sans (SIL OFL) ships in src/assets/fonts and is loaded through Vite as a URL asset, then
 * handed to pdfmake as base64 in its virtual filesystem. This is what makes Ә, Ғ, Қ, Ң, Ө, Ұ, Ү,
 * Һ, І, Russian Cyrillic and ₸ render as real glyphs instead of blank boxes — nothing here relies
 * on a font being present on the viewer's machine.
 *
 * pdfmake and the fonts are loaded on demand (dynamic import) so ~1.6 MB stays out of the main
 * bundle for everyone who never opens an invoice.
 */

type FontFaces = { normal: string; bold: string; italics: string; bolditalics: string };

/**
 * pdfmake 0.3's browser API, which differs from the 0.2 one most examples show:
 *  - fonts/vfs are registered through addVirtualFileSystem()/addFonts(), not by assigning
 *    `.vfs` and `.fonts` (assigning them leaves the file "not found in virtual file system")
 *  - getBlob() is async and returns a Promise; the old callback form never fires, which
 *    presents as a silent hang rather than an error.
 */
type PdfMakeStatic = {
  addVirtualFileSystem: (vfs: Record<string, string>) => void;
  addFonts: (fonts: Record<string, FontFaces>) => void;
  createPdf: (def: unknown) => { getBlob: () => Promise<Blob> };
};

let pdfMakePromise: Promise<PdfMakeStatic> | null = null;

async function fetchAsBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Қаріпті жүктеу мүмкін болмады (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // Chunked conversion: String.fromCharCode(...buf) on a ~550 KB font overflows the call stack.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Loads pdfmake once and registers the Cyrillic font with it. Subsequent calls reuse the result. */
async function getPdfMake(): Promise<PdfMakeStatic> {
  if (!pdfMakePromise) {
    pdfMakePromise = (async () => {
      const [{ default: pdfMakeModule }, regular, bold] = await Promise.all([
        import("pdfmake/build/pdfmake"),
        fetchAsBase64(notoRegularUrl),
        fetchAsBase64(notoBoldUrl),
      ]);
      const pdfMake = pdfMakeModule as unknown as PdfMakeStatic;
      pdfMake.addVirtualFileSystem({
        "NotoSans-Regular.ttf": regular,
        "NotoSans-Bold.ttf": bold,
      });
      pdfMake.addFonts({
        NotoSans: {
          normal: "NotoSans-Regular.ttf",
          bold: "NotoSans-Bold.ttf",
          // No italic face is bundled; mapping them to the upright ones keeps pdfmake from
          // falling back to a Latin-only default if a style is ever requested.
          italics: "NotoSans-Regular.ttf",
          bolditalics: "NotoSans-Bold.ttf",
        },
      });
      return pdfMake;
    })().catch((err) => {
      pdfMakePromise = null; // let a later attempt retry rather than caching the failure
      throw err;
    });
  }
  return pdfMakePromise;
}

/** Builds the pdfmake document definition for one invoice. Exported so the layout can be
 *  verified directly (see scripts/verify-invoice-pdf.mjs) without going through a browser. */
export function buildInvoiceDocDefinition(invoice: Invoice, companyName: string) {
  const money = (tiyn: number) => formatMoney(tiyn);

  const itemRows = invoice.lines.map((line, i) => [
    { text: String(i + 1), alignment: "center" as const },
    { text: line.name },
    { text: String(line.qty), alignment: "right" as const },
    { text: line.unit, alignment: "center" as const },
    { text: money(line.unitPriceTiyn), alignment: "right" as const },
    { text: money(line.totalTiyn), alignment: "right" as const },
  ]);

  const totalsRows: { text: string; bold?: boolean }[][] = [
    [{ text: "Аралық сома" }, { text: money(invoice.subtotalTiyn) }],
  ];
  if (invoice.discountTiyn > 0) {
    totalsRows.push([{ text: "Жеңілдік" }, { text: `−${money(invoice.discountTiyn)}` }]);
  }
  totalsRows.push([{ text: "Жалпы сома", bold: true }, { text: money(invoice.totalTiyn), bold: true }]);
  totalsRows.push([{ text: "Төленді" }, { text: money(invoice.paidTiyn) }]);
  totalsRows.push([{ text: "Қарыз" }, { text: money(invoice.debtTiyn) }]);

  return {
    pageSize: "A4",
    pageMargins: [36, 36, 36, 46],
    defaultStyle: { font: "NotoSans", fontSize: 9 },
    content: [
      {
        columns: [
          [
            { text: companyName, fontSize: 14, bold: true },
            { text: "Жиһаз бөлшектерін кесу цехы", fontSize: 8, color: "#6b7280" },
          ],
          [
            { text: "НАКЛАДНОЙ", fontSize: 14, bold: true, alignment: "right" },
            { text: `№ ${invoice.invoiceNumber}`, fontSize: 9, alignment: "right", color: "#6b7280" },
            ...(invoice.version > 1
              ? [{ text: `Нұсқа: ${invoice.version}`, fontSize: 8, alignment: "right", color: "#6b7280" }]
              : []),
          ],
        ],
      },
      { canvas: [{ type: "line", x1: 0, y1: 6, x2: 523, y2: 6, lineWidth: 1.4 }], margin: [0, 6, 0, 12] },
      {
        columns: [
          [
            { text: "Заказ", fontSize: 8, color: "#6b7280" },
            { text: invoice.orderNumber, bold: true },
          ],
          [
            { text: "Күні", fontSize: 8, color: "#6b7280" },
            { text: invoice.issuedAt ? formatDateTimeDMY(invoice.issuedAt) : "—", bold: true },
          ],
          [
            { text: "Клиент", fontSize: 8, color: "#6b7280" },
            { text: invoice.customerName, bold: true },
          ],
          [
            { text: "Телефон", fontSize: 8, color: "#6b7280" },
            { text: invoice.customerPhone ? formatPhone(invoice.customerPhone) : "—", bold: true },
          ],
        ],
        margin: [0, 0, 0, 14],
      },
      {
        table: {
          headerRows: 1,
          widths: [22, "*", 42, 46, 74, 78],
          body: [
            [
              { text: "№", bold: true, alignment: "center" },
              { text: "Атауы", bold: true },
              { text: "Саны", bold: true, alignment: "right" },
              { text: "Бірлік", bold: true, alignment: "center" },
              { text: "Бағасы", bold: true, alignment: "right" },
              { text: "Сомасы", bold: true, alignment: "right" },
            ],
            ...(itemRows.length > 0
              ? itemRows
              : [[{ text: "Жол жоқ", colSpan: 6, alignment: "center", color: "#9ca3af" }, {}, {}, {}, {}, {}]]),
          ],
        },
        layout: {
          hLineColor: () => "#d7dae3",
          vLineColor: () => "#d7dae3",
        },
      },
      {
        columns: [
          { text: "", width: "*" },
          {
            width: 240,
            margin: [0, 14, 0, 0],
            table: {
              widths: ["*", "auto"],
              body: totalsRows.map(([label, value]) => [
                { text: label.text, bold: label.bold, border: [false, false, false, false] },
                {
                  text: value.text,
                  bold: value.bold,
                  alignment: "right" as const,
                  border: [false, false, false, false],
                },
              ]),
            },
          },
        ],
      },
      ...(invoice.paymentMethods.length > 0
        ? [{ text: `Төлем әдісі: ${invoice.paymentMethods.join(", ")}`, margin: [0, 14, 0, 0], fontSize: 9 }]
        : []),
      ...(invoice.note ? [{ text: invoice.note, margin: [0, 10, 0, 0], fontSize: 9, italics: false }] : []),
      {
        columns: [
          [
            { text: "Менеджер", fontSize: 8, color: "#6b7280" },
            { text: invoice.issuedByName, bold: true },
          ],
          [
            { text: "Қолы", fontSize: 8, color: "#6b7280", alignment: "right" },
            {
              canvas: [{ type: "line", x1: 100, y1: 16, x2: 240, y2: 16, lineWidth: 0.8 }],
            },
          ],
        ],
        margin: [0, 40, 0, 0],
      },
    ],
  };
}

/** Generates the invoice PDF as a Blob — the same bytes every time, from the stored snapshot. */
export async function renderInvoicePdf(invoice: Invoice, companyName: string): Promise<Blob> {
  const pdfMake = await getPdfMake();
  const def = buildInvoiceDocDefinition(invoice, companyName);
  return pdfMake.createPdf(def).getBlob();
}

/** `INV-2026-00001-Almat.pdf` — safe for every filesystem, and still identifiable. */
export function invoicePdfFilename(invoice: Invoice): string {
  const slug = invoice.customerName
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${invoice.invoiceNumber}${slug ? `-${slug}` : ""}.pdf`;
}

/** Generates and downloads the PDF. */
export async function downloadInvoicePdf(invoice: Invoice, companyName: string): Promise<void> {
  const blob = await renderInvoicePdf(invoice, companyName);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = invoicePdfFilename(invoice);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoked on the next tick so the download has definitely started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
