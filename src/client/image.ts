import type { FileUIPart } from "ai";
import { MAX_DOCUMENT_BYTES, MAX_IMAGE_EDGE_PX } from "../shared";

/**
 * Re-encode a picked photo as a JPEG no larger than the models can use. Drawing through a
 * canvas also drops all metadata (EXIF, including GPS location), so only pixels are uploaded.
 */
export async function prepareImage(file: File): Promise<FileUIPart> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable");
    // JPEG has no transparency; put transparent images on white rather than black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { type: "file", mediaType: "image/jpeg", url: canvas.toDataURL("image/jpeg", 0.85) };
  } finally {
    bitmap.close();
  }
}

function dataUrl(mediaType: string, bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${mediaType};base64,${btoa(binary)}`;
}

/** Whether the bytes read as text (valid UTF-8 with no NUL bytes), whatever the file is called. */
function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn a picked file into something the models accept: photos are shrunk and stripped of
 * metadata, PDFs are sent as they are, and any text-like file (notes, CSV, JSON, code) is
 * sent as plain text. Throws a message for the user when the file cannot be used.
 */
export async function prepareAttachment(file: File): Promise<FileUIPart> {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (file.type.startsWith("image/") && file.type !== "image/svg+xml") return prepareImage(file);
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new Error(`${file.name} is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isPdf) return { type: "file", mediaType: "application/pdf", filename: file.name, url: dataUrl("application/pdf", bytes) };
  if (bytes.length > 0 && isText(bytes)) {
    return { type: "file", mediaType: "text/plain", filename: file.name, url: dataUrl("text/plain", bytes) };
  }
  throw new Error(`${file.name} is not a photo, PDF or text file.`);
}
