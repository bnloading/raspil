// Renders a sample "Накладной" through pdfmake with the bundled Noto Sans faces and asserts that
// every Kazakh-specific letter, Russian Cyrillic and the ₸ sign actually made it into the PDF as
// real glyphs — not blank boxes. Run:
//   node scripts/verify-invoice-pdf.mjs [outputPath]
//
// This exercises the same font files and the same page layout the app ships; it uses pdfmake's
// Node printer rather than the browser build purely so it can run headlessly in CI.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

// pdfmake's Node entry is CommonJS and uses extensionless internal requires, which ESM cannot
// resolve — load it through createRequire rather than a bare `import`.
const require = createRequire(import.meta.url);
const PrinterModule = require("pdfmake/js/Printer.js");
const PdfPrinter = PrinterModule.default ?? PrinterModule;

const here = dirname(fileURLToPath(import.meta.url));
const fontsDir = resolve(here, "../src/assets/fonts");
const out = resolve(process.argv[2] ?? resolve(here, "../invoice-sample.pdf"));

const KAZAKH = "ӘҒҚҢӨҰҮҺІәғқңөұүһі";
const RUSSIAN = "ЙЦУКЕНГШЩЗХЪЁьы";
const TENGE = "₸";

// pdfmake 0.3's Printer routes every font path through a urlResolver before loading it. Local
// files need no fetching, so this resolver is a no-op that simply reports everything as resolved.
const localFileResolver = {
  resolve: () => {},
  resolved: () => Promise.resolve(),
};

const printer = new PdfPrinter(
  {
    NotoSans: {
      normal: resolve(fontsDir, "NotoSans-Regular.ttf"),
      bold: resolve(fontsDir, "NotoSans-Bold.ttf"),
      italics: resolve(fontsDir, "NotoSans-Regular.ttf"),
      bolditalics: resolve(fontsDir, "NotoSans-Bold.ttf"),
    },
  },
  undefined,
  localFileResolver,
  () => true, // localAccessPolicy: these are our own bundled font files
);

const money = (t) => `${(t / 100).toLocaleString("ru-RU")} ₸`;

const invoice = {
  invoiceNumber: "INV-2026-00042",
  orderNumber: "ORD-2026-000123",
  version: 2,
  customerName: "Әбдіғали Ұлықбек Қажымұқан",
  customerPhone: "+7 (702) 123-45-67",
  lines: [
    { name: "ЛДСП Ақ — Ғафу Қайырбеков", qty: 6, unit: "лист", unitPriceTiyn: 1620000, totalTiyn: 9720000 },
    { name: "ПВХ жиек Өң Һәм Іс", qty: 89, unit: "м", unitPriceTiyn: 20000, totalTiyn: 1780000 },
    { name: "Распил қызметі Ңұсқа", qty: 6, unit: "лист", unitPriceTiyn: 500000, totalTiyn: 3000000 },
  ],
  subtotalTiyn: 14500000,
  discountTiyn: 500000,
  totalTiyn: 14000000,
  paidTiyn: 9000000,
  debtTiyn: 5000000,
  paymentMethods: ["Нал / Қолма-қол", "Kaspi"],
  note: `Ескертпе: ${KAZAKH} — ${RUSSIAN}`,
  issuedByName: "Нұрбақыт Мұқағали",
};

const docDefinition = {
  pageSize: "A4",
  pageMargins: [36, 36, 36, 46],
  // Verification only: pdfmake compresses streams by default, which would leave the ToUnicode
  // CMap unreadable to the assertions below. The app ships with compression left on.
  compress: false,
  defaultStyle: { font: "NotoSans", fontSize: 9 },
  content: [
    {
      columns: [
        [
          { text: "Цех Трекер", fontSize: 14, bold: true },
          { text: "Жиһаз бөлшектерін кесу цехы", fontSize: 8, color: "#6b7280" },
        ],
        [
          { text: "НАКЛАДНОЙ", fontSize: 14, bold: true, alignment: "right" },
          { text: `№ ${invoice.invoiceNumber}`, fontSize: 9, alignment: "right", color: "#6b7280" },
          { text: `Нұсқа: ${invoice.version}`, fontSize: 8, alignment: "right", color: "#6b7280" },
        ],
      ],
    },
    { canvas: [{ type: "line", x1: 0, y1: 6, x2: 523, y2: 6, lineWidth: 1.4 }], margin: [0, 6, 0, 12] },
    {
      columns: [
        [{ text: "Заказ", fontSize: 8, color: "#6b7280" }, { text: invoice.orderNumber, bold: true }],
        [{ text: "Күні", fontSize: 8, color: "#6b7280" }, { text: "27.08.2026, 17:20", bold: true }],
        [{ text: "Клиент", fontSize: 8, color: "#6b7280" }, { text: invoice.customerName, bold: true }],
        [{ text: "Телефон", fontSize: 8, color: "#6b7280" }, { text: invoice.customerPhone, bold: true }],
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
          ...invoice.lines.map((l, i) => [
            { text: String(i + 1), alignment: "center" },
            { text: l.name },
            { text: String(l.qty), alignment: "right" },
            { text: l.unit, alignment: "center" },
            { text: money(l.unitPriceTiyn), alignment: "right" },
            { text: money(l.totalTiyn), alignment: "right" },
          ]),
        ],
      },
      layout: { hLineColor: () => "#d7dae3", vLineColor: () => "#d7dae3" },
    },
    {
      columns: [
        { text: "", width: "*" },
        {
          width: 240,
          margin: [0, 14, 0, 0],
          table: {
            widths: ["*", "auto"],
            body: [
              [{ text: "Аралық сома", border: [false, false, false, false] }, { text: money(invoice.subtotalTiyn), alignment: "right", border: [false, false, false, false] }],
              [{ text: "Жеңілдік", border: [false, false, false, false] }, { text: `−${money(invoice.discountTiyn)}`, alignment: "right", border: [false, false, false, false] }],
              [{ text: "Жалпы сома", bold: true, border: [false, false, false, false] }, { text: money(invoice.totalTiyn), bold: true, alignment: "right", border: [false, false, false, false] }],
              [{ text: "Төленді", border: [false, false, false, false] }, { text: money(invoice.paidTiyn), alignment: "right", border: [false, false, false, false] }],
              [{ text: "Қарыз", border: [false, false, false, false] }, { text: money(invoice.debtTiyn), alignment: "right", border: [false, false, false, false] }],
            ],
          },
        },
      ],
    },
    { text: `Төлем әдісі: ${invoice.paymentMethods.join(", ")}`, margin: [0, 14, 0, 0], fontSize: 9 },
    { text: invoice.note, margin: [0, 10, 0, 0], fontSize: 9 },
    {
      columns: [
        [{ text: "Менеджер", fontSize: 8, color: "#6b7280" }, { text: invoice.issuedByName, bold: true }],
        [{ text: "Қолы", fontSize: 8, color: "#6b7280", alignment: "right" }],
      ],
      margin: [0, 40, 0, 0],
    },
  ],
};

// createPdfKitDocument is async in pdfmake 0.3.
const pdfDoc = await printer.createPdfKitDocument(docDefinition);
const chunks = [];
pdfDoc.on("data", (c) => chunks.push(c));
pdfDoc.on("end", () => {
  const buf = Buffer.concat(chunks);
  writeFileSync(out, buf);

  // --- assertions -------------------------------------------------------
  const failures = [];
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") failures.push("not a PDF (bad magic bytes)");
  if (buf.length < 20000) failures.push(`suspiciously small (${buf.length} bytes) — font probably not embedded`);

  const raw = buf.toString("latin1");
  // A subsetted TrueType font must be embedded; without it Cyrillic cannot render.
  if (!/\/FontFile2/.test(raw)) failures.push("no embedded TrueType font (/FontFile2 missing)");
  if (!/NotoSans/.test(raw)) failures.push("Noto Sans not referenced in the PDF");

  // Every Kazakh letter must map to a real glyph. The embedded subset carries a ToUnicode CMap;
  // collect every codepoint it maps, expanding BOTH forms the spec allows:
  //   bfchar:  <src> <dst>
  //   bfrange: <lo> <hi> <dstStart>   |   <lo> <hi> [<d1> <d2> …]
  // Ignoring bfrange (which packs consecutive glyphs into one entry) makes letters look missing
  // when they are actually present.
  const toUnicode = new Set();
  const addHex = (hex) => {
    // A destination may be a UTF-16BE string; the first unit is the character itself.
    for (let i = 0; i < hex.length; i += 4) {
      toUnicode.add(parseInt(hex.slice(i, i + 4), 16));
      break;
    }
  };

  for (const block of raw.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) addHex(m[2]);
  }

  for (const block of raw.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1];
    // Array form first, so its entries aren't re-matched by the scalar form below.
    for (const m of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g)) {
      for (const d of m[3].matchAll(/<([0-9a-fA-F]+)>/g)) addHex(d[1]);
    }
    const arrayFormRemoved = body.replace(/<[0-9a-fA-F]+>\s*<[0-9a-fA-F]+>\s*\[[\s\S]*?\]/g, "");
    for (const m of arrayFormRemoved.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const dst = parseInt(m[3].slice(0, 4), 16);
      for (let i = 0; i <= hi - lo; i++) toUnicode.add(dst + i);
    }
  }

  const toUnicodeHex = new Set([...toUnicode].map((cp) => cp.toString(16).toUpperCase().padStart(4, "0")));

  const required = [...new Set([...KAZAKH, ...RUSSIAN, TENGE])];
  const missing = required.filter((ch) => {
    const hex = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    return !toUnicodeHex.has(hex);
  });
  if (missing.length) failures.push(`glyphs missing from the PDF's ToUnicode map: ${missing.join(" ")}`);

  console.log(`PDF written: ${out}`);
  console.log(`  size: ${buf.length} bytes`);
  console.log(`  embedded font: ${/\/FontFile2/.test(raw) ? "yes (/FontFile2)" : "NO"}`);
  console.log(`  distinct unicode codepoints mapped: ${toUnicodeHex.size}`);
  console.log(`  Kazakh letters checked: ${KAZAKH}`);
  console.log(`  Russian letters checked: ${RUSSIAN}`);
  console.log(`  tenge sign checked: ${TENGE}`);

  if (failures.length) {
    console.error("\nFAILED:");
    for (const f of failures) console.error("  ✗ " + f);
    process.exit(1);
  }
  console.log("\n✓ All Kazakh, Russian and ₸ glyphs are present in the generated PDF.");
});
pdfDoc.end();
