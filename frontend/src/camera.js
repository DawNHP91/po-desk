// Slip photos. The phone's own camera app opens through <input capture>, never getUserMedia
// (CLAUDE.md: in-browser camera streams are unreliable on Android). Photos are checked for size,
// turned upright from their EXIF orientation, downscaled to 1600 px on the long edge and
// re-encoded as JPEG at about 0.75: roughly 200–600 KB, plenty for reading a till slip.

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_EDGE = 1600;
export const JPEG_QUALITY = 0.75;

export class PhotoError extends Error {}

/** Two hidden inputs: the camera (capture) and the gallery (no capture). onFile gets the chosen File. */
export function makeInputs(onFile) {
  const mk = (capture) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (capture) input.setAttribute('capture', 'environment');
    input.className = 'hidden';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.value = '';                       // lets the same photo be chosen again after a retake
      if (file) onFile(file);
    });
    return input;
  };
  return { camera: mk(true), gallery: mk(false) };
}

/** Size check, upright, downscaled JPEG. Returns { dataUrl, base64, width, height, bytes, orientation }. */
export async function processPhoto(file) {
  if (file.size > MAX_FILE_BYTES) {
    throw new PhotoError('This photo is ' + (file.size / 1048576).toFixed(1) + ' MB; the limit is 8 MB. Take it again, or choose a smaller photo.');
  }
  if (file.type && !/^image\//.test(file.type)) throw new PhotoError('That file isn’t a photo.');
  const head = await file.slice(0, 256 * 1024).arrayBuffer();
  const orientation = readExifOrientation(head);
  const img = await decode(file);
  // Modern browsers already turn <img> upright from EXIF; only rotate by hand where they don't.
  const manual = (await browserAppliesExif()) ? 1 : orientation;
  const canvas = drawOriented(img, img.naturalWidth, img.naturalHeight, manual, MAX_EDGE);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  if (!blob) throw new PhotoError('The photo could not be prepared. Please try again.');
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new PhotoError('The photo could not be prepared. Please try again.'));
    r.readAsDataURL(blob);
  });
  return { dataUrl, base64: String(dataUrl).split(',')[1], width: canvas.width, height: canvas.height, bytes: blob.size, orientation };
}

function decode(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new PhotoError('This photo can’t be opened here. Use “Take photo”, or choose a JPEG.')); };
    img.src = url;
  });
}

/**
 * Draws src at most maxEdge on its long side, applying EXIF orientation 1–8 by hand.
 * Exported so the transform can be tested with a plain canvas.
 */
export function drawOriented(src, srcW, srcH, orientation, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const swap = orientation >= 5 && orientation <= 8;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
    default: break;
  }
  ctx.drawImage(src, 0, 0, w, h);
  return canvas;
}

/** EXIF Orientation (1–8) from the start of a JPEG; 1 when absent or unreadable. */
export function readExifOrientation(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let off = 2;
  while (off + 4 <= v.byteLength) {
    const marker = v.getUint16(off);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return 1;   // not a marker, or image data begins
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && off + 10 <= v.byteLength && v.getUint32(off + 4) === 0x45786966 && v.getUint16(off + 8) === 0) {
      const tiff = off + 10;
      if (tiff + 8 > v.byteLength) return 1;
      const little = v.getUint16(tiff) === 0x4949;
      const ifd = tiff + v.getUint32(tiff + 4, little);
      if (ifd + 2 > v.byteLength) return 1;
      const count = v.getUint16(ifd, little);
      for (let i = 0; i < count; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > v.byteLength) return 1;
        if (v.getUint16(e, little) === 0x0112) {
          const o = v.getUint16(e + 8, little);
          return o >= 1 && o <= 8 ? o : 1;
        }
      }
      return 1;
    }
    off += 2 + len;
  }
  return 1;
}

// A 2x1 JPEG tagged "rotate 90°": a browser that honours EXIF decodes it as 1x2.
const EXIF_PROBE = 'data:image/jpeg;base64,/9j/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAQAAAAD/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD9qKKKK4wP/9k=';
let autoExif = null;

export function browserAppliesExif() {
  if (!autoExif) {
    autoExif = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth === 1 && img.naturalHeight === 2);
      img.onerror = () => resolve(false);
      img.src = EXIF_PROBE;
    });
  }
  return autoExif;
}
