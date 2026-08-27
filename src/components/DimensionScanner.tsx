import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Spinner } from "../components";

interface DimensionScannerProps {
  onDetected: (dims: { lengthMm: number; widthMm: number }) => void;
  onClose: () => void;
}

type Stage = "pick" | "recognizing" | "result" | "error";

/**
 * Parses OCR text for a pair of dimensions.
 * Prefers an "AxB"-style match (e.g. "600x450", "600х450", "600*450").
 * Falls back to the first two standalone 2-5 digit numbers found anywhere.
 */
function parseDimensions(text: string): { lengthMm: number; widthMm: number } {
  const pairMatch = text.match(/(\d{2,5})\s*[xXхХ*]\s*(\d{2,5})/);
  if (pairMatch) {
    return { lengthMm: parseInt(pairMatch[1], 10), widthMm: parseInt(pairMatch[2], 10) };
  }
  const nums = text.match(/\d{2,5}/g) || [];
  return {
    lengthMm: nums[0] ? parseInt(nums[0], 10) : 0,
    widthMm: nums[1] ? parseInt(nums[1], 10) : 0,
  };
}

export function DimensionScanner({ onDetected, onClose }: DimensionScannerProps) {
  const [stage, setStage] = useState<Stage>("pick");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rawText, setRawText] = useState("");
  const [lengthMm, setLengthMm] = useState(0);
  const [widthMm, setWidthMm] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep the object URL cleaned up across re-picks/unmount.
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
  };

  const handlePickAnother = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl(null);
    setStage("pick");
    setRawText("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleRecognize = async () => {
    if (!file) return;
    setStage("recognizing");
    try {
      const Tesseract = await import("tesseract.js");
      const worker = await Tesseract.createWorker("eng");
      try {
        await worker.setParameters({
          tessedit_char_whitelist: "0123456789xXхХ*., ",
        });
        const { data } = await worker.recognize(file);
        setRawText(data.text.trim());
        const parsed = parseDimensions(data.text);
        setLengthMm(parsed.lengthMm);
        setWidthMm(parsed.widthMm);
        setStage("result");
      } finally {
        await worker.terminate();
      }
    } catch {
      setRawText("");
      setLengthMm(0);
      setWidthMm(0);
      setStage("error");
    }
  };

  const canConfirm = lengthMm > 0 && widthMm > 0;

  const handleConfirm = () => {
    if (!canConfirm) return;
    onDetected({ lengthMm, widthMm });
    onClose();
  };

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
              <label className="btn-add-item" style={{ display: "block", textAlign: "center", cursor: "pointer" }}>
                📷 Сурет таңдау немесе түсіру
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handleFileChange}
                  hidden
                  disabled={stage === "recognizing"}
                />
              </label>
            )}

            {stage === "recognizing" && <Spinner />}

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
            <p className="field-error">Тани алмадым, қолмен енгізіңіз</p>
            <div className="form-group">
              <label>Ұзындығы (мм)</label>
              <input
                type="number"
                className="form-input"
                value={lengthMm || ""}
                min={0}
                onChange={(e) => setLengthMm(parseFloat(e.target.value) || 0)}
              />
            </div>
            <div className="form-group">
              <label>Ені (мм)</label>
              <input
                type="number"
                className="form-input"
                value={widthMm || ""}
                min={0}
                onChange={(e) => setWidthMm(parseFloat(e.target.value) || 0)}
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={handlePickAnother}>
                Басқа сурет
              </button>
              <button type="button" className="btn btn-primary" disabled={!canConfirm} onClick={handleConfirm}>
                ✅ Қосу
              </button>
            </div>
          </>
        )}

        {stage === "result" && (
          <>
            <p style={{ fontSize: "0.8rem", color: "var(--text-light)", wordBreak: "break-word" }}>
              Танылған мәтін: {rawText || "(бос)"}
            </p>
            <div className="form-group">
              <label>Ұзындығы (мм)</label>
              <input
                type="number"
                className="form-input"
                value={lengthMm || ""}
                min={0}
                onChange={(e) => setLengthMm(parseFloat(e.target.value) || 0)}
              />
            </div>
            <div className="form-group">
              <label>Ені (мм)</label>
              <input
                type="number"
                className="form-input"
                value={widthMm || ""}
                min={0}
                onChange={(e) => setWidthMm(parseFloat(e.target.value) || 0)}
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={handlePickAnother}>
                Басқа сурет
              </button>
              <button type="button" className="btn btn-primary" disabled={!canConfirm} onClick={handleConfirm}>
                ✅ Қосу
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
