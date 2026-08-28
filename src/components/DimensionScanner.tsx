import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Spinner } from "../components";
import { NumberField } from "./NumberField";
import { parseScannedParts, type ScannedPart } from "../lib/ocrDimensions";

interface DimensionScannerProps {
  /** Every row the photo yielded, already reviewed and corrected by the user. */
  onDetected: (parts: ScannedPart[]) => void;
  onClose: () => void;
}

type Stage = "pick" | "recognizing" | "result" | "error";

/** A failed scan still needs somewhere to type, so the manual fallback opens with one empty row. */
const BLANK_ROW = (): ScannedPart => ({ lengthMm: 0, widthMm: 0, qty: 1 });

/**
 * Straightens a phone photo out into something Tesseract can actually read.
 *
 * Raw camera images fail OCR for mundane reasons: the digits are small relative to the frame, the
 * paper is grey rather than white, and JPEG noise blurs thin strokes. Upscaling to a target width,
 * converting to greyscale and then hard-stretching the contrast fixes all three, and is the single
 * biggest difference between "танымады" and a clean read. Returns a PNG blob because re-encoding
 * as JPEG would put back the compression artefacts this just removed.
 */
async function preprocess(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);

  // Tesseract wants roughly 30px-tall glyphs; on a list of ~20 rows, 1800px of width gets there
  // for a typical phone photo. Never downscale — that would destroy detail we need.
  const TARGET_W = 1800;
  const scale = Math.max(1, Math.min(3, TARGET_W / bitmap.width));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
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
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png");
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
  const [rows, setRows] = useState<ScannedPart[]>([]);
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

  const handleRecognize = async () => {
    if (!file) return;
    setStage("recognizing");
    setProgress(0);
    try {
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
        const source = await preprocess(file).catch(() => file); // a preprocessing failure must not lose the scan
        const { data } = await worker.recognize(source);
        const text = data.text ?? "";
        setRawText(text.trim());
        const parsed = parseScannedParts(text);
        setRows(parsed.length > 0 ? parsed : [BLANK_ROW()]);
        setStage(parsed.length > 0 ? "result" : "error");
      } finally {
        await worker.terminate();
      }
    } catch {
      setRawText("");
      setRows([BLANK_ROW()]);
      setStage("error");
    }
  };

  const patchRow = (index: number, patch: Partial<ScannedPart>) =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const removeRow = (index: number) => setRows((prev) => prev.filter((_, i) => i !== index));

  const addRow = () => setRows((prev) => [...prev, BLANK_ROW()]);

  const valid = rows.filter((r) => r.lengthMm > 0 && r.widthMm > 0);
  const totalPieces = valid.reduce((s, r) => s + Math.max(1, r.qty), 0);

  const handleConfirm = () => {
    if (valid.length === 0) return;
    onDetected(valid);
    onClose();
  };

  const rowTable = (
    <>
      <div className="scan-rows">
        {rows.map((row, i) => (
          <div key={i} className="scan-row">
            <span className="scan-row-num">{i + 1}</span>
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
                <p className="scan-hint">Танылуда… {progress}%</p>
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
