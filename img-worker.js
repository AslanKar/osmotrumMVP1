/* img-worker.js (Phase 1 / Local Mode)
 * Offline-only image pipeline in Web Worker:
 *  - decode
 *  - normalize orientation
 *  - resize by long side <= max_long_side_px
 *  - smart JPEG compression until <= target_max_bytes
 *  - return original (unchanged) + normalized JPEG (for UI/PDF)
 *
 * HEIC/HEIF:
 *  1) try WebCodecs ImageDecoder (if available)
 *  2) else try WASM decoder if provided via init
 *  3) else fail with clear message (user must pick JPEG/PNG)
 */

"use strict";

let RUNTIME = {
  ready: false,
  maxLongSidePx: 2560,          // from Config.DB or default from TЗ
  targetMaxBytes: null,         // MUST come from Config.DB
  jpegQualityStart: 0.95,
  jpegMinQuality: 0.65,
  jpegQualityStep: 0.05,
  maxQualityIters: 8,
  maxResizePasses: 4,
  resizeDownFactor: 0.9,
  heicWasm: null,               // optional: { decodeToRGBA: async (arrayBuffer)->{width,height,rgba,orientation?} }
};

function isFiniteNumber(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function inferMime(file) {
  const t = (file && file.type) ? String(file.type) : "";
  if (t) return t.toLowerCase();
  const name = (file && file.name) ? String(file.name).toLowerCase() : "";
  if (name.endsWith(".heic")) return "image/heic";
  if (name.endsWith(".heif")) return "image/heif";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  return "";
}

function isHeicLike(mime) {
  return mime === "image/heic" || mime === "image/heif" || mime === "image/heic-sequence" || mime === "image/heif-sequence";
}

function err(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

function ok(payload) {
  return { ok: true, ...payload };
}

// --- EXIF Orientation (JPEG only) ---
async function readJpegExifOrientation(blob) {
  // returns 1..8 (default 1)
  try {
    const buf = await blob.arrayBuffer();
    const dv = new DataView(buf);

    // JPEG SOI 0xFFD8
    if (dv.getUint16(0, false) !== 0xFFD8) return 1;
    let offset = 2;

    while (offset + 4 < dv.byteLength) {
      const marker = dv.getUint16(offset, false);
      offset += 2;

      // EOI or SOS stops parsing
      if (marker === 0xFFD9 || marker === 0xFFDA) break;

      const size = dv.getUint16(offset, false);
      offset += 2;
      if (size < 2) break;

      // APP1
      if (marker === 0xFFE1) {
        // "Exif\0\0"
        const exifHeader =
          dv.getUint32(offset, false) === 0x45786966 && dv.getUint16(offset + 4, false) === 0x0000;
        if (!exifHeader) {
          offset += size - 2;
          continue;
        }

        const tiffOffset = offset + 6;
        const little = dv.getUint16(tiffOffset, false) === 0x4949;
        const getU16 = (o) => dv.getUint16(o, little);
        const getU32 = (o) => dv.getUint32(o, little);

        const magic = getU16(tiffOffset + 2);
        if (magic !== 0x002A) return 1;

        const ifd0Rel = getU32(tiffOffset + 4);
        let ifd0 = tiffOffset + ifd0Rel;
        if (ifd0 + 2 > dv.byteLength) return 1;

        const entries = getU16(ifd0);
        ifd0 += 2;

        for (let i = 0; i < entries; i++) {
          const entry = ifd0 + i * 12;
          if (entry + 12 > dv.byteLength) break;
          const tag = getU16(entry);
          if (tag === 0x0112) {
            // Orientation
            const type = getU16(entry + 2);
            const count = getU32(entry + 4);
            if (type !== 3 || count !== 1) return 1;
            const value = getU16(entry + 8);
            if (value >= 1 && value <= 8) return value;
            return 1;
          }
        }
        return 1;
      }

      offset += size - 2;
    }

    return 1;
  } catch {
    return 1;
  }
}

function orientedSize(w, h, orientation) {
  // orientations 5..8 swap width/height
  if (orientation >= 5 && orientation <= 8) return { w: h, h: w };
  return { w, h };
}

function drawBitmapWithOrientation(ctx, bitmap, orientation, outW, outH) {
  // outW/outH are dimensions AFTER orientation
  ctx.save();
  // white background (important for PNG transparency -> JPEG)
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, outW, outH);

  // Transform based on EXIF orientation
  switch (orientation) {
    case 2: // mirror horizontal
      ctx.translate(outW, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(bitmap, 0, 0, outW, outH);
      break;
    case 3: // rotate 180
      ctx.translate(outW, outH);
      ctx.rotate(Math.PI);
      ctx.drawImage(bitmap, 0, 0, outW, outH);
      break;
    case 4: // mirror vertical
      ctx.translate(0, outH);
      ctx.scale(1, -1);
      ctx.drawImage(bitmap, 0, 0, outW, outH);
      break;
    case 5: // mirror horizontal + rotate 270
      ctx.rotate(-Math.PI / 2);
      ctx.scale(-1, 1);
      ctx.translate(-outH, 0);
      ctx.drawImage(bitmap, 0, 0, outH, outW);
      break;
    case 6: // rotate 90
      ctx.rotate(Math.PI / 2);
      ctx.translate(0, -outW);
      ctx.drawImage(bitmap, 0, 0, outH, outW);
      break;
    case 7: // mirror horizontal + rotate 90
      ctx.rotate(Math.PI / 2);
      ctx.scale(-1, 1);
      ctx.translate(-outH, -outW);
      ctx.drawImage(bitmap, 0, 0, outH, outW);
      break;
    case 8: // rotate 270
      ctx.rotate(-Math.PI / 2);
      ctx.translate(-outH, 0);
      ctx.drawImage(bitmap, 0, 0, outH, outW);
      break;
    case 1:
    default:
      ctx.drawImage(bitmap, 0, 0, outW, outH);
      break;
  }

  ctx.restore();
}

async function bitmapFromNonHeic(file) {
  // Best path: ask browser to apply orientation itself
  try {
    const bm = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { bitmap: bm, orientation: 1, orientationMode: "native_from-image" };
  } catch {
    // Fallback: manual EXIF for JPEG + createImageBitmap without options
    const mime = inferMime(file);
    let orientation = 1;
    if (mime === "image/jpeg") orientation = await readJpegExifOrientation(file);
    const bm = await createImageBitmap(file);
    return { bitmap: bm, orientation, orientationMode: "manual_exif_or_unknown" };
  }
}

async function bitmapFromHeic(file) {
  // 1) WebCodecs ImageDecoder if available
  if (typeof ImageDecoder !== "undefined") {
    try {
      const mime = inferMime(file) || "image/heic";
      const data = await file.arrayBuffer();
      const dec = new ImageDecoder({ data, type: mime });
      const { image } = await dec.decode({ frameIndex: 0 });
      // image is a VideoFrame
      const bm = await createImageBitmap(image);
      image.close();
      dec.close?.();
      return { bitmap: bm, orientation: 1, orientationMode: "webcodecs_imagedecoder" };
    } catch {
      // continue
    }
  }

  // 2) WASM decoder if provided
  if (RUNTIME.heicWasm && typeof RUNTIME.heicWasm.decodeToRGBA === "function") {
    const data = await file.arrayBuffer();
    const decoded = await RUNTIME.heicWasm.decodeToRGBA(data);
    // decoded: {width,height,rgba:Uint8Array, orientation?}
    if (!decoded || !decoded.width || !decoded.height || !decoded.rgba) {
      throw new Error("HEIC WASM decoder returned invalid payload");
    }

    const w = decoded.width;
    const h = decoded.height;
    const rgba = decoded.rgba;
    const orientation = decoded.orientation || 1;

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: false });
    const imgData = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h);
    ctx.putImageData(imgData, 0, 0);
    const bm = canvas.transferToImageBitmap();
    // cleanup
    canvas.width = 0; canvas.height = 0;

    return { bitmap: bm, orientation, orientationMode: "wasm_rgba" };
  }

  // 3) fail
  throw new Error("HEIC decode not available (no WebCodecs ImageDecoder and no WASM decoder provided)");
}

async function renderResizedJpeg({ bitmap, orientation, maxLongSidePx, targetMaxBytes }) {
  if (!isFiniteNumber(maxLongSidePx) || maxLongSidePx <= 0) throw new Error("Invalid maxLongSidePx");
  if (!isFiniteNumber(targetMaxBytes) || targetMaxBytes <= 0) throw new Error("Invalid targetMaxBytes");
  if (typeof OffscreenCanvas === "undefined") throw new Error("OffscreenCanvas is required for worker pipeline");

  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const oSize = orientedSize(srcW, srcH, orientation);

  // resize scale by long side
  const longSide = Math.max(oSize.w, oSize.h);
  let scale = longSide > maxLongSidePx ? (maxLongSidePx / longSide) : 1;

  let pass = 0;
  let best = null;

  while (pass < RUNTIME.maxResizePasses) {
    const outW = Math.max(1, Math.round(oSize.w * scale));
    const outH = Math.max(1, Math.round(oSize.h * scale));

    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext("2d", { alpha: false });

    drawBitmapWithOrientation(ctx, bitmap, orientation, outW, outH);

    // quality loop
    let q = RUNTIME.jpegQualityStart;
    let iter = 0;
    let jpegBlob = null;

    while (iter < RUNTIME.maxQualityIters) {
      jpegBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: q });

      if (jpegBlob.size <= targetMaxBytes) {
        best = { blob: jpegBlob, width: outW, height: outH, quality: q, scale, pass, iter };
        break;
      }

      const nextQ = Math.max(RUNTIME.jpegMinQuality, q - RUNTIME.jpegQualityStep);
      if (nextQ === q) break; // reached min
      q = nextQ;
      iter++;
    }

    // If success -> break
    if (best) {
      // cleanup
      canvas.width = 0; canvas.height = 0;
      return best;
    }

    // Not successful: reduce dimensions and try again
    canvas.width = 0; canvas.height = 0;

    scale = scale * RUNTIME.resizeDownFactor;
    pass++;
  }

  // last attempt result (still too big) — return best-effort but with flag
  // Make one final render at current scale with min quality
  const outW = Math.max(1, Math.round(oSize.w * scale));
  const outH = Math.max(1, Math.round(oSize.h * scale));
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext("2d", { alpha: false });
  drawBitmapWithOrientation(ctx, bitmap, orientation, outW, outH);
  const jpegBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: RUNTIME.jpegMinQuality });
  canvas.width = 0; canvas.height = 0;

  return {
    blob: jpegBlob,
    width: outW,
    height: outH,
    quality: RUNTIME.jpegMinQuality,
    scale,
    pass: RUNTIME.maxResizePasses,
    iter: RUNTIME.maxQualityIters,
    bestEffortOverLimit: jpegBlob.size > targetMaxBytes
  };
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const type = msg.type;

  try {
    if (type === "init") {
      const config = msg.config || null;

      const maxLongSide = config?.constraints?.images?.max_long_side_px;
      const targetMax = config?.constraints?.images?.target_max_bytes;

      RUNTIME.maxLongSidePx = isFiniteNumber(maxLongSide) ? maxLongSide : 2560; // default allowed by TЗ
      RUNTIME.targetMaxBytes = isFiniteNumber(targetMax) ? targetMax : null;

      // optional overrides for tuning (still deterministic)
      const o = msg.overrides || {};
      if (isFiniteNumber(o.jpegQualityStart)) RUNTIME.jpegQualityStart = o.jpegQualityStart;
      if (isFiniteNumber(o.jpegMinQuality)) RUNTIME.jpegMinQuality = o.jpegMinQuality;
      if (isFiniteNumber(o.jpegQualityStep)) RUNTIME.jpegQualityStep = o.jpegQualityStep;
      if (isFiniteNumber(o.maxQualityIters)) RUNTIME.maxQualityIters = o.maxQualityIters;
      if (isFiniteNumber(o.maxResizePasses)) RUNTIME.maxResizePasses = o.maxResizePasses;
      if (isFiniteNumber(o.resizeDownFactor)) RUNTIME.resizeDownFactor = o.resizeDownFactor;

      // Optional HEIC WASM decoder hook
      // Expected shape: { decodeToRGBA: async (arrayBuffer) => {width,height,rgba:Uint8Array,orientation?} }
      if (msg.heicWasmDecoder) {
        RUNTIME.heicWasm = msg.heicWasmDecoder;
      }

      RUNTIME.ready = true;

      const warnings = [];
      if (!RUNTIME.targetMaxBytes) {
        warnings.push("Missing constraints.images.target_max_bytes in Config.DB — processing will fail until provided.");
      }

      self.postMessage(ok({
        type: "init_ok",
        runtime: {
          maxLongSidePx: RUNTIME.maxLongSidePx,
          targetMaxBytes: RUNTIME.targetMaxBytes,
          hasHeicWasm: !!RUNTIME.heicWasm,
          hasWebCodecsImageDecoder: typeof ImageDecoder !== "undefined"
        },
        warnings
      }));
      return;
    }

    if (type === "process") {
      if (!RUNTIME.ready) {
        self.postMessage(err("E_NOT_INITIALIZED", "Worker is not initialized. Call init() first.", { type: "process_err" }));
        return;
      }

      if (!RUNTIME.targetMaxBytes) {
        self.postMessage(err(
          "E_CONFIG_TARGET_MAX_BYTES_MISSING",
          "В Config.DB нет constraints.images.target_max_bytes. Добавь этот параметр, иначе нельзя гарантировать размер JPEG.",
          { type: "process_err" }
        ));
        return;
      }

      const requestId = msg.requestId || "";
      const file = msg.file;
      if (!file) {
        self.postMessage(err("E_NO_FILE", "No file provided", { type: "process_err", requestId }));
        return;
      }

      const mime = inferMime(file);
      const originalBytes = file.size;

      // decode
      let decoded;
      if (isHeicLike(mime)) {
        try {
          decoded = await bitmapFromHeic(file);
        } catch (e) {
          self.postMessage(err(
            "E_HEIC_CONVERT_FAILED",
            "Не удалось конвертировать HEIC/HEIF офлайн. Выберите фото в JPEG/PNG.",
            { type: "process_err", requestId, detail: String(e?.message || e) }
          ));
          return;
        }
      } else {
        decoded = await bitmapFromNonHeic(file);
      }

      const bitmap = decoded.bitmap;
      const orientation = decoded.orientation || 1;

      // process -> normalized jpeg
      const normalized = await renderResizedJpeg({
        bitmap,
        orientation,
        maxLongSidePx: RUNTIME.maxLongSidePx,
        targetMaxBytes: RUNTIME.targetMaxBytes
      });

      // cleanup
      bitmap.close?.();

      const debug = {
        input: { mime, bytes: originalBytes, name: file.name || "" },
        decode: { orientation, mode: decoded.orientationMode, srcW: decoded.bitmap?.width, srcH: decoded.bitmap?.height },
        output: {
          mime: "image/jpeg",
          bytes: normalized.blob.size,
          width: normalized.width,
          height: normalized.height,
          quality: normalized.quality,
          scale: normalized.scale,
          pass: normalized.pass,
          iter: normalized.iter,
          bestEffortOverLimit: !!normalized.bestEffortOverLimit
        },
        limits: { maxLongSidePx: RUNTIME.maxLongSidePx, targetMaxBytes: RUNTIME.targetMaxBytes }
      };

      self.postMessage(ok({
        type: "process_ok",
        requestId,
        original: { blob: file, mime: mime || file.type || "", bytes: originalBytes },
        normalized: { blob: normalized.blob, mime: "image/jpeg", bytes: normalized.blob.size, width: normalized.width, height: normalized.height },
        debug
      }));
      return;
    }

    self.postMessage(err("E_UNKNOWN_MESSAGE", `Unknown message type: ${type}`, { type: "unknown_err" }));
  } catch (e) {
    self.postMessage(err("E_WORKER_EXCEPTION", "Unhandled worker exception", { detail: String(e?.message || e) }));
  }
};
