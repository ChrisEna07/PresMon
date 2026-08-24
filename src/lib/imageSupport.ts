export interface CompressedImage {
  dataUrl: string;
  fileName: string;
  approxBytes: number;
}

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 0.72;
/** Firestore acepta docs de ~1 MB; dejamos margen amplio. */
const MAX_BYTES = 700_000;

/**
 * Comprime una imagen del cliente (foto de cédula, recibo, etc.) a un
 * dataURL JPEG pequeño para poder viajar en el documento de la solicitud.
 */
export async function compressImageFile(file: File): Promise<CompressedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('El soporte debe ser una imagen (JPG o PNG).');
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No se pudo procesar la imagen.');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  let quality = JPEG_QUALITY;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  while (dataUrl.length * 0.75 > MAX_BYTES && quality > 0.3) {
    quality -= 0.12;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }
  const approxBytes = Math.round(dataUrl.length * 0.75);
  if (approxBytes > MAX_BYTES) {
    throw new Error('La imagen es demasiado grande incluso comprimida. Toma la foto con menos resolución.');
  }
  return {
    dataUrl,
    fileName: file.name.replace(/\.[^.]+$/, '') + '-soporte.jpg',
    approxBytes,
  };
}
