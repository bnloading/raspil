import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Spinner } from "../components";
import { NumberField } from "./NumberField";
import { parseScannedParts, type ScannedPart } from "../lib/ocrDimensions";
import { isHandwritingModelLoaded, recognizeHandwriting, type HandwritingQuality } from "../lib/handwritingOcr";

interface DimensionScannerProps {
  /** Every row the photo yielded, already reviewed and corrected by the user. */
  onDetected: (parts: ScannedPart[]) => void;
  onClose: () => void;
}

type Stage = "pick" | "recognizing" | "result" | "error";
/** "handwritten" = TrOCR (reads handwriting, ~60 MB once); "printed" = Tesseract (small, fast). */
type Engine = "handwritten" | "printed";

/** A failed scan still needs somewhere to type, so the manual fallback opens with one empty row. */
const BLANK_ROW = (): ScannedPart => ({ lengthMm: 0, widthMm: 0, qty: 1 });

/**
 * Renders `bitmap` into a w×h canvas, rotated by `deg` about its own centre — the one place both
 * the skew search below and the real correction draw a rotated frame, so whatever sign convention
 * canvas rotation happens to use, the angle the search picks straightens the same way when applied
 * for real.
 */
function drawRotated(bitmap: ImageBitmap, w: number, h: number, deg: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.imageSmoothingQuality = "high";
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  ctx.restore();
  return ctx;
}

/**
 * Estimates the small rotation (degrees) that straightens a tilted photo of a written list.
 *
 * Level text rows produce a horizontal projection (dark-pixel count per row) with sharp peaks
 * where ink sits and troughs where it doesn't; tilting the page smears every row's ink across its
 * neighbours and flattens that profile. So the angle that maximises the projection's variance is
 * the angle that best undoes the tilt — no line detection or geometry needed, just try angles and
 * keep the sharpest one. Runs on a small downsampled copy (a phone can afford ~30 of these; it
 * could not afford 30 passes at full photo resolution) and returns the angle for the real draw.
 */
function detectSkewDeg(bitmap: ImageBitmap): number {
  const SEARCH_W = 300;
  const w = SEARCH_W;
  const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * SEARCH_W));

  let bestDeg = 0;
  let bestVariance = -Infinity;
  for (let deg = -8; deg <= 8; deg += 0.5) {
    const { data } = drawRotated(bitmap, w, h, deg).getImageData(0, 0, w, h);
    const rowDarkCount = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      let count = 0;
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        const grey = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        if (grey < 150) count++;
      }
      rowDarkCount[y] = count;
    }
    const mean = rowDarkCount.reduce((s, v) => s + v, 0) / h;
    const variance = rowDarkCount.reduce((s, v) => s + (v - mean) ** 2, 0) / h;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestDeg = deg;
    }
  }
  return bestDeg;
}

/**
 * Straightens a phone photo out into something Tesseract (or TrOCR) can actually read.
 *
 * Raw camera images fail OCR for mundane reasons: the photo is tilted a few degrees off the page,
 * the digits are small relative to the frame, the paper is grey rather than white, and JPEG noise
 * blurs thin strokes. Deskewing, upscaling to a target width, converting to greyscale and then
 * hard-stretching the contrast fixes all four, and is the single biggest difference between
 * "танымады" and a clean read. Returns a PNG blob because re-encoding as JPEG would put back the
 * compression artefacts this just removed.
 */
async function preprocess(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const skewDeg = detectSkewDeg(bitmap);

  // Tesseract wants roughly 30px-tall glyphs; on a list of ~20 rows, 1800px of width gets there
  // for a typical phone photo. Never downscale — that would destroy detail we need.
  const TARGET_W = 1800;
  const scale = Math.min(Math.max(1, Math.min(3, TARGET_W / bitmap.width)), 3200 / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  // A rotation this small (≤8°) only clips a thin sliver at the corners, which is empty margin on
  // every real cut-list photo — never worth the complexity of expanding the canvas to fit it.
  // Below that threshold the estimate is noise, not a real tilt, so it's left alone rather than
  // applied.
  const ctx = drawRotated(bitmap, w, h, Math.abs(skewDeg) >= 0.5 ? skewDeg : 0);
  bitmap.close();

  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;

  // Greyscale first, tracking the range so the stretch below adapts to this photo's own exposure
  // rather than to a fixed threshold that would blow out a dim shot and flatten a bright one.
  let min = 255;
  let max = 0;
  for (let i = 0; i < px.length; i += 4) {
    const grey = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
    px[i] = px[i + 1] = px[i + 2] = grey;
    if (grey < min) min = grey;
    if (grey > max) max = grey;
  }

  const span = Math.max(1, max - min);
  for (let i = 0; i < px.length; i += 4) {
    // Stretch to full range, then push away from the midpoint so ink goes black and paper white.
    const n = ((px[i] - min) / span) * 255;
    const boosted = n < 128 ? n * 0.6 : 255 - (255 - n) * 0.6;
    const v = Math.max(0, Math.min(255, boosted)) | 0;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);

  return await new Promise<Blob>((resolve, reject) => {
    ctx.canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png");
  });
}

/**
 * "Суреттен өлшем алу" — photograph a cut list, get its rows as parts.
 *
 * Reads every row it can rather than a single pair, because the lists people photograph have
 * dozens of parts on them, and then shows them in an editable table: OCR is never trusted blindly,
 * but nor is the user made to retype what was read correctly.
 */
export function DimensionScanner({ onDetected, onClose }: DimensionScannerProps) {
  const [stage, setStage] = useState<Stage>("pick");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rawText, setRawText] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressNote, setProgressNote] = useState("");
  /** Which recogniser to use. Remembered: a shop that writes lists by hand always writes by hand. */
  const [engine, setEngine] = useState<Engine>(
    () => (localStorage.getItem("scanEngine") as Engine) || "handwritten",
  );
  useEffect(() => {
    localStorage.setItem("scanEngine", engine);
  }, [engine]);
  const [rows, setRows] = useState<ScannedPart[]>([]);
  /** Skips the download warning once the weights are already in memory this session. */
  const [quality, setQuality] = useState<HandwritingQuality>("accurate");
  const modelReady = isHandwritingModelLoaded(quality);
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    if (!picked) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(picked);
    setPreviewUrl(URL.createObjectURL(picked));
    setStage("pick");
    setRawText("");
    setRows([]);
  };

  const handlePickAnother = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl(null);
    setStage("pick");
    setRawText("");
    setRows([]);
    setProgress(0);
    if (galleryRef.current) galleryRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
  };

  const finish = (text: string) => {
    setRawText(text.trim());
    const parsed = parseScannedParts(text);
    setRows(parsed.length > 0 ? parsed : [BLANK_ROW()]);
    setStage(parsed.length > 0 ? "result" : "error");
  };

  /** Printed lists: Tesseract, small and fast, already bundled. */
  const runPrinted = async (source: Blob) => {
    const Tesseract = await import("tesseract.js");
    const worker = await Tesseract.createWorker("eng", 1, {
      logger: (m: { status: string; progress: number }) => {
        if (m.status === "recognizing text") setProgress(Math.round(m.progress * 100));
      },
    });
    try {
      // No tessedit_char_whitelist here on purpose. It constrains the legacy engine, but the
      // LSTM engine tesseract.js runs by default degrades badly under one — it was the reason
      // this scanner returned nothing at all. Misread letters are repaired in ocrDimensions.ts
      // instead, where the surrounding context makes the correction safe.
      const { data } = await worker.recognize(source);
      return data.text ?? "";
    } finally {
      await worker.terminate();
    }
  };

  /** Handwritten lists: TrOCR, which is what Tesseract's printed-text models cannot do. */
  const runHandwritten = async (source: Blob, qualityOverride?: HandwritingQuality) => {
    return await recognizeHandwriting(source, (p) => {
      if (p.stage === "download") {
        setProgress(Math.round((p.progress ?? 0) * 100));
        setProgressNote("Модель жүктелуде (бір рет қана)…");
      } else if (p.stage === "segment") {
        setProgressNote("Жолдарға бөлінуде…");
      } else {
        setProgress(Math.round((p.progress ?? 0) * 100));
        setProgressNote(p.detail ?? "Оқылуда…");
      }
    }, qualityOverride ?? quality);
  };

  const handleRecognize = async () => {
    if (!file) return;
    setStage("recognizing");
    setProgress(0);
    setProgressNote("");
    try {
      const source = await preprocess(file).catch(() => file); // preprocessing failure must not lose the scan
      let text = engine === "handwritten" ? await runHandwritten(source) : await runPrinted(source);

      // Neither engine reads the other's kind of writing — a printed list run through TrOCR (or a
      // handwritten one through Tesseract) comes back as noise, which looks identical from here
      // to "no list in the photo". Trying the other engine once before giving up turns a manual
      // "switch and rescan" into a single tap, at the cost of one extra pass only when the first
      // one actually found nothing.
      if (parseScannedParts(text).length === 0) {
        const fallbackEngine: Engine = engine === "handwritten" ? "printed" : "handwritten";
        setProgressNote(
          fallbackEngine === "handwritten"
            ? "Ештеңе табылмады, қолжазба режиммен қайталануда…"
            : "Ештеңе табылмады, басылған режиммен қайталануда…",
        );
        // Not asked for, so it shouldn't force the big download either — reuse whatever quality
        // is already in memory, or fall back to the small model rather than the large one.
        const fallbackQuality: HandwritingQuality = isHandwritingModelLoaded("accurate") ? "accurate" : "fast";
        const fallbackText = fallbackEngine === "handwritten"
          ? await runHandwritten(source, fallbackQuality)
          : await runPrinted(source);
        if (parseScannedParts(fallbackText).length > 0) text = fallbackText;
      }

      finish(text);
    } catch (err) {
      setRawText(err instanceof Error ? err.message : "");
      setRows([BLANK_ROW()]);
      setStage("error");
    } finally {
      setProgressNote("");
    }
  };

  const patchRow = (index: number, patch: Partial<ScannedPart>) =>
    setRows((prev) => prev.map((r, i) => {
      if (i !== index) return r;
      // Touching either dimension is the "glance" the ⚠ was asking for — cleared whether the
      // number changed or was retyped the same, since either way it's now been looked at.
      const clearsUncertain = "lengthMm" in patch || "widthMm" in patch;
      return { ...r, ...patch, ...(clearsUncertain ? { uncertain: false } : {}) };
    }));

  const removeRow = (index: number) => setRows((prev) => prev.filter((_, i) => i !== index));

  const addRow = () => setRows((prev) => [...prev, BLANK_ROW()]);

  const valid = rows.filter((r) => r.lengthMm > 0 && r.widthMm > 0);
  const totalPieces = valid.reduce((s, r) => s + Math.max(1, r.qty), 0);
  const uncertainCount = rows.filter((r) => r.uncertain).length;

  const handleConfirm = () => {
    if (valid.length === 0) return;
    onDetected(valid);
    onClose();
  };

  const rowTable = (
    <>
      <div className="scan-rows">
        {rows.map((row, i) => (
          <div
            key={i}
            className={`scan-row${row.uncertain ? " is-uncertain" : ""}`}
            title={row.uncertain ? "Бұл жолдың сандары анық танылмаған — тексеріп алыңыз" : undefined}
          >
            <span className="scan-row-num">{row.uncertain ? "⚠" : i + 1}</span>
            <NumberField
              className="form-input bulk-num"
              value={row.lengthMm}
              onChange={(v) => patchRow(i, { lengthMm: v })}
              ariaLabel={`${i + 1}-жол: ұзындығы`}
            />
            <span className="bulk-x">×</span>
            <NumberField
              className="form-input bulk-num"
              value={row.widthMm}
              onChange={(v) => patchRow(i, { widthMm: v })}
              ariaLabel={`${i + 1}-жол: ені`}
            />
            <NumberField
              className="form-input bulk-num bulk-num-qty"
              value={row.qty}
              emptyValue={1}
              onChange={(v) => patchRow(i, { qty: v })}
              ariaLabel={`${i + 1}-жол: саны`}
            />
            <button type="button" className="scan-row-del" onClick={() => removeRow(i)} aria-label="Жолды жою">
              ✕
            </button>
          </div>
        ))}
      </div>

      <button type="button" className="btn btn-outline btn-sm" onClick={addRow}>
        ＋ Жол қосу
      </button>

      <div className="summary-row" style={{ marginTop: 12 }}>
        <span>Танылған деталь</span>
        <strong>
          {valid.length} жол · {totalPieces} дана
        </strong>
      </div>
    </>
  );

  return (
    <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-handle" />
        <h2>📷 Суреттен өлшем алу</h2>

        {(stage === "pick" || stage === "recognizing") && (
          <>
            {previewUrl ? (
              <div style={{ textAlign: "center", marginBottom: 16 }}>
                <img
                  src={previewUrl}
                  alt="Таңдалған сурет"
                  style={{ maxWidth: "100%", maxHeight: 260, borderRadius: 12 }}
                />
              </div>
            ) : (
              <>
                <p className="scan-hint">
                  Размерлер жазылған қағазды түсіріңіз. Әр жолда «600x450 2шт» түрінде жазылса,
                  барлығы бірден танылады.
                </p>
                {/* Two separate inputs: `capture` opens the camera directly, but on several Android
                    browsers it also removes the option to pick an existing photo — which is exactly
                    what the user was trying to do when nothing was recognised. */}
                <label className="btn-add-item scan-pick-btn">
                  🖼 Галереядан таңдау
                  <input ref={galleryRef} type="file" accept="image/*" onChange={handleFileChange} hidden />
                </label>
                <label className="btn-add-item scan-pick-btn">
                  📷 Камерамен түсіру
                  <input
                    ref={cameraRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handleFileChange}
                    hidden
                  />
                </label>
              </>
            )}

            {stage === "recognizing" && (
              <div style={{ textAlign: "center" }}>
                <Spinner />
                <p className="scan-hint">
                  {progressNote || "Танылуда…"} {progress > 0 && `${progress}%`}
                </p>
              </div>
            )}

            {previewUrl && stage === "pick" && (
              <div className="form-group">
                <label>Жазу түрі</label>
                <div className="pay-method-grid">
                  <button
                    type="button"
                    className={`pay-method-option${engine === "handwritten" ? " is-active" : ""}`}
                    onClick={() => setEngine("handwritten")}
                  >
                    ✍️ Қолжазба
                  </button>
                  <button
                    type="button"
                    className={`pay-method-option${engine === "printed" ? " is-active" : ""}`}
                    onClick={() => setEngine("printed")}
                  >
                    🖨 Басылған
                  </button>
                </div>
                {engine === "handwritten" && <label className="scan-quality">Тану моделі
                  <select className="form-input" value={quality} onChange={e => setQuality(e.target.value as HandwritingQuality)}>
                    <option value="accurate">TrOCR Base — үлкен модель</option>
                    <option value="fast">TrOCR Small — жеңіл модель</option>
                  </select>
                </label>}
                {engine === "handwritten" && !modelReady && (
                  <p className="form-hint">
                    Модель алғаш қолданғанда жүктеледі: Base бірнеше жүз МБ, Small шамамен 60 МБ. Сурет құрылғыда өңделеді, API кілті қажет емес. Үлкен модель баяуырақ; телефон жады жетпесе, жеңіл модельді таңдаңыз.
                  </p>
                )}
              </div>
            )}

            {previewUrl && stage === "pick" && (
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={handlePickAnother}>
                  Басқа сурет
                </button>
                <button type="button" className="btn btn-primary" onClick={handleRecognize}>
                  🔍 Тану
                </button>
              </div>
            )}
          </>
        )}

        {stage === "error" && (
          <>
            <p className="field-error">
              Суреттен размер таба алмадым. Жарығы жақсы, тік түсірілген сурет көбіне жақсы
              танылады. Төмендегі жолдарды қолмен де толтыруға болады.
            </p>
            {rowTable}
            {rawText && (
              <p className="scan-raw">
                <button type="button" className="link-button" onClick={() => setShowRaw((v) => !v)}>
                  {showRaw ? "Танылған мәтінді жасыру" : "Танылған мәтінді көру"}
                </button>
                {showRaw && <span className="scan-raw-text">{rawText}</span>}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={handlePickAnother}>
                Басқа сурет
              </button>
              <button type="button" className="btn btn-primary" disabled={valid.length === 0} onClick={handleConfirm}>
                ✅ Қосу
              </button>
            </div>
          </>
        )}

        {stage === "result" && (
          <>
            <p className="scan-hint">
              ✅ {rows.length} жол танылды. Қатесін түзетіп, «Қосу» батырмасын басыңыз.
            </p>
            {uncertainCount > 0 && (
              <p className="scan-hint is-uncertain-hint">
                ⚠ {uncertainCount} жол анық танылмаған (⚠ белгісімен көрсетілген) — сандарын
                тексеріп алыңыз.
              </p>
            )}
            {rowTable}
            <p className="scan-raw">
              <button type="button" className="link-button" onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? "Танылған мәтінді жасыру" : "Танылған мәтінді көру"}
              </button>
              {showRaw && <span className="scan-raw-text">{rawText || "(бос)"}</span>}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={handlePickAnother}>
                Басқа сурет
              </button>
              <button type="button" className="btn btn-primary" disabled={valid.length === 0} onClick={handleConfirm}>
                ✅ {totalPieces} деталь қосу
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
