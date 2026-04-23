// Pure-JS metadata stripper for JPEG / PNG / WebP. Removes EXIF, XMP, IPTC,
// and text-chunk metadata while preserving color data (ICC profiles) and
// image content. No native deps — runs inside a Cloudflare Worker.
//
// On unsupported formats (HEIC, GIF, TIFF, etc.) the input is returned
// unchanged. Callers should prefer JPEG/PNG/WebP; a log line is emitted for
// formats we can't clean so it's visible in `wrangler tail`.

export type StripResult = {
  bytes: Uint8Array;
  stripped: boolean;   // true if we removed at least one metadata segment
  format: "jpeg" | "png" | "webp" | "unknown";
};

export function stripMetadata(mime: string, bytes: Uint8Array): StripResult {
  const fmt = detectFormat(mime, bytes);
  try {
    switch (fmt) {
      case "jpeg": return stripJpeg(bytes);
      case "png":  return stripPng(bytes);
      case "webp": return stripWebp(bytes);
      default:     return { bytes, stripped: false, format: "unknown" };
    }
  } catch (err) {
    // Any parser failure: return the original bytes rather than a broken file.
    console.warn(`exif strip failed (${fmt}):`, err instanceof Error ? err.message : String(err));
    return { bytes, stripped: false, format: fmt };
  }
}

function detectFormat(mime: string, b: Uint8Array): StripResult["format"] {
  // Trust magic bytes over MIME — phones lie.
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp"; // "WEBP"
  // Fall back to MIME hint for future formats we might add.
  const m = mime.toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpeg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  return "unknown";
}

// ---------------------------------------------------------------------------
// JPEG — drop APP1 (EXIF/XMP), APP12 (Ducky), APP13 (Photoshop/IPTC) markers.
// Keep APP0 (JFIF), APP2 (ICC), APP14 (Adobe) so color stays correct.
// ---------------------------------------------------------------------------

function stripJpeg(b: Uint8Array): StripResult {
  const out: number[] = [0xff, 0xd8]; // SOI
  let i = 2;
  let stripped = false;

  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error(`bad JPEG segment at ${i}`);
    // Skip fill bytes — a run of 0xFF is legal between segments.
    while (i < b.length && b[i] === 0xff) i++;
    if (i >= b.length) break;
    const marker = b[i++];

    // SOI / EOI / RSTn / TEM have no length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(0xff, marker);
      if (marker === 0xd9) break; // EOI — we're done
      continue;
    }

    // SOS (0xDA): variable-length header followed by entropy-coded data until
    // the next non-RST, non-0x00 marker (usually EOI). Copy the SOS header by
    // its declared length, then copy bytes until we hit the next real marker.
    if (marker === 0xda) {
      if (i + 2 > b.length) throw new Error("truncated SOS length");
      const len = (b[i] << 8) | b[i + 1];
      if (i + len > b.length) throw new Error("truncated SOS segment");
      out.push(0xff, 0xda);
      for (let j = 0; j < len; j++) out.push(b[i + j]);
      i += len;
      // Copy scan data up to the next marker.
      while (i < b.length) {
        const byte = b[i++];
        out.push(byte);
        if (byte !== 0xff) continue;
        // 0xFF followed by 0x00 is an escaped literal; 0xFF 0xFFn is padding.
        while (i < b.length && b[i] === 0xff) { out.push(b[i++]); }
        if (i >= b.length) break;
        const next = b[i];
        if (next === 0x00) { out.push(b[i++]); continue; } // stuffed byte
        if (next >= 0xd0 && next <= 0xd7) { out.push(b[i++]); continue; } // RSTn
        // Real marker — rewind so the outer loop handles it.
        out.pop(); // remove the trailing 0xFF we pushed
        i--;       // put 0xFF back
        break;
      }
      continue;
    }

    // Everything else: 2-byte big-endian length including the length bytes.
    if (i + 2 > b.length) throw new Error(`truncated marker ${marker.toString(16)}`);
    const len = (b[i] << 8) | b[i + 1];
    if (len < 2 || i + len > b.length) throw new Error(`bad length for marker ${marker.toString(16)}`);
    const segStart = i - 2; // includes 0xFF + marker
    const segEnd = i + len; // exclusive

    if (isJpegMetadataMarker(marker, b, i + 2, i + len)) {
      stripped = true;
      i = segEnd;
      continue;
    }

    for (let j = segStart; j < segEnd; j++) out.push(b[j]);
    i = segEnd;
  }

  return { bytes: Uint8Array.from(out), stripped, format: "jpeg" };
}

function isJpegMetadataMarker(marker: number, b: Uint8Array, dataStart: number, dataEnd: number): boolean {
  // APP1: EXIF ("Exif\0\0") or XMP ("http://ns.adobe.com/xap/1.0/\0").
  if (marker === 0xe1) {
    const hdr = readAscii(b, dataStart, Math.min(dataEnd, dataStart + 32));
    return hdr.startsWith("Exif") || hdr.startsWith("http://ns.adobe.com/xap/");
  }
  // APP12 "Ducky" — Photoshop save-for-web metadata.
  if (marker === 0xec) {
    return readAscii(b, dataStart, Math.min(dataEnd, dataStart + 6)).startsWith("Ducky");
  }
  // APP13 "Photoshop 3.0" — IPTC / Photoshop metadata.
  if (marker === 0xed) {
    return readAscii(b, dataStart, Math.min(dataEnd, dataStart + 14)).startsWith("Photoshop");
  }
  // COM comment marker.
  if (marker === 0xfe) return true;
  return false;
}

function readAscii(b: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i++) {
    const c = b[i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// ---------------------------------------------------------------------------
// PNG — drop eXIf, tEXt, iTXt, zTXt chunks. Keep everything else; CRCs of
// kept chunks are preserved byte-for-byte.
// ---------------------------------------------------------------------------

function stripPng(b: Uint8Array): StripResult {
  const out: number[] = [];
  for (let i = 0; i < 8; i++) out.push(b[i]); // signature
  let i = 8;
  let stripped = false;
  const drop = new Set(["eXIf", "tEXt", "iTXt", "zTXt"]);

  while (i < b.length) {
    if (i + 8 > b.length) throw new Error("truncated PNG chunk header");
    const len = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    const chunkEnd = i + 8 + len + 4; // + CRC
    if (chunkEnd > b.length || len < 0) throw new Error(`bad PNG chunk ${type}`);

    if (drop.has(type)) {
      stripped = true;
      i = chunkEnd;
      if (type === "IEND") break;
      continue;
    }

    for (let j = i; j < chunkEnd; j++) out.push(b[j]);
    i = chunkEnd;
    if (type === "IEND") break;
  }

  return { bytes: Uint8Array.from(out), stripped, format: "png" };
}

// ---------------------------------------------------------------------------
// WebP — RIFF container. Drop EXIF and XMP chunks, clear their flag bits in
// VP8X, and fix the RIFF size header.
// ---------------------------------------------------------------------------

function stripWebp(b: Uint8Array): StripResult {
  if (b.length < 12) throw new Error("truncated WebP");
  const out: number[] = [];
  for (let i = 0; i < 12; i++) out.push(b[i]); // "RIFF" + size + "WEBP"
  let i = 12;
  let stripped = false;

  // VP8X flags byte sits at offset 20 (inside the VP8X chunk, 8 bytes past
  // the chunk header that starts at offset 12). We may need to clear bits.
  let vp8xFlagsIndexInOut = -1;

  while (i + 8 <= b.length) {
    const fourcc = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
    const size = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24);
    const payloadEnd = i + 8 + size;
    const padded = payloadEnd + (size & 1); // RIFF chunks pad to even size
    if (padded > b.length) throw new Error(`bad WebP chunk ${fourcc}`);

    if (fourcc === "EXIF" || fourcc === "XMP ") {
      stripped = true;
      i = padded;
      continue;
    }

    if (fourcc === "VP8X") {
      vp8xFlagsIndexInOut = out.length + 8; // flags byte is first of payload
    }

    for (let j = i; j < padded; j++) out.push(b[j]);
    i = padded;
  }

  if (stripped && vp8xFlagsIndexInOut >= 0 && vp8xFlagsIndexInOut < out.length) {
    // Clear EXIF (bit 3) and XMP (bit 2) flags.
    out[vp8xFlagsIndexInOut] &= ~((1 << 3) | (1 << 2));
  }

  // Fix RIFF size = total - 8.
  const total = out.length;
  const riffSize = total - 8;
  out[4] = riffSize & 0xff;
  out[5] = (riffSize >> 8) & 0xff;
  out[6] = (riffSize >> 16) & 0xff;
  out[7] = (riffSize >> 24) & 0xff;

  return { bytes: Uint8Array.from(out), stripped, format: "webp" };
}
