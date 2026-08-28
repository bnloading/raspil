import { segmentLines, toGrey } from "./lineSegmentation";

/**
 * Handwriting recognition with TrOCR, running in the browser.
 *
 * Tesseract's models are trained on printed text and are unreliable on a handwritten cut list —
 * that is a property of the model, not of the photo, so no amount of preprocessing fixes it.
 * TrOCR is a transformer trained on handwriting and reads these lists.
 *
 * Two things about TrOCR shape this module:
 *
 *  1. It recognises ONE line per image and performs no layout analysis, so the page is split into
 *     lines first (lib/lineSegmentation.ts) and each line is recognised separately.
 *  2. The weights are ~60 MB (quantised small model). That is a real download, so it happens on
 *     demand rather than at page load, is reported through `onProgress`, and the browser caches it
 *     for later scans.
 */

/** Quantised so it is 60 MB rather than the ~320 MB of trocr-base — small is enough for digits. */
const MODEL_ID = "Xenova/trocr-small-handwritten";

export interface OcrProgress {
  stage: "download" | "segment" | "recognize";
  /** 0..1 within the current stage, or undefined when not measurable. */
  progress?: number;
  /** Human-readable detail, e.g. "3 / 12 жол". */
  detail?: string;
}

type Recognizer = (input: unknown) => Promise<Array<{ generated_text: string }>>;

let pipelinePromise: Promise<Recognizer> | null = null;

/**
 * Loads (and caches) the model. Kept module-level so a second scan in the same session reuses the
 * already-initialised pipeline instead of re-reading 60 MB out of the browser cache.
 */
async function getRecognizer(onProgress?: (p: OcrProgress) => void): Promise<Recognizer> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return (await pipeline("image-to-text", MODEL_ID, {
        dtype: "q8",
        progress_callback: (p: { status?: string; progress?: number; file?: string }) => {
          if (p.status === "progress" && typeof p.progress === "number") {
            onProgress?.({ stage: "download", progress: p.progress / 100, detail: p.file });
          }
        },
      })) as unknown as Recognizer;
    })().catch((err) => {
      pipelinePromise = null; // a failed load must not poison every later attempt
      throw err;
    });
  }
  return pipelinePromise;
}

/** True once the weights are in memory, so the UI can skip the download warning. */
export function isHandwritingModelLoaded(): boolean {
  return pipelinePromise !== null;
}

/**
 * Reads a photographed, handwritten list and returns its text, one line per row.
 *
 * The returned string is newline-separated so it can be handed straight to
 * `parseScannedParts` in lib/ocrDimensions.ts, exactly like the Tesseract path.
 */
export async function recognizeHandwriting(
  source: Blob,
  onProgress?: (p: OcrProgress) => void,
): Promise<string> {
  const recognizer = await getRecognizer(onProgress);

  onProgress?.({ stage: "segment" });
  const bitmap = await createImageBitmap(source);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const grey = toGrey(data, canvas.width, canvas.height);
  const lines = segmentLines(grey, canvas.width, canvas.height);

  // No bands found means the page is blank or the contrast is hopeless; recognising the whole
  // image is a better last resort than returning nothing.
  const boxes = lines.length > 0 ? lines : [{ top: 0, bottom: canvas.height }];

  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const { top, bottom } = boxes[i];
    onProgress?.({
      stage: "recognize",
      progress: i / boxes.length,
      detail: `${i + 1} / ${boxes.length} жол`,
    });

    const h = bottom - top;
    if (h <= 0) continue;
    const crop = document.createElement("canvas");
    crop.width = canvas.width;
    crop.height = h;
    const cctx = crop.getContext("2d");
    if (!cctx) continue;
    // White behind the crop: TrOCR expects dark text on light paper, and a transparent canvas
    // would otherwise composite to black and invert the line.
    cctx.fillStyle = "#fff";
    cctx.fillRect(0, 0, crop.width, crop.height);
    cctx.drawImage(canvas, 0, top, canvas.width, h, 0, 0, canvas.width, h);

    const blob = await new Promise<Blob | null>((r) => crop.toBlob(r, "image/png"));
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    try {
      const result = await recognizer(url);
      const text = result?.[0]?.generated_text?.trim();
      if (text) out.push(text);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  onProgress?.({ stage: "recognize", progress: 1 });
  return out.join("\n");
}
