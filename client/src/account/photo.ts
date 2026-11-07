import type { Ack } from '../../../shared/types';
import { PHOTO_MAX_BYTES, PHOTO_SIZE_PX, type AccountView } from '../../../shared/account';
import { NO_RESPONSE } from '../socket';
import { authToken } from './session';

/** Najnižšia kvalita, na ktorú pri zmenšovaní súboru klesneme (pod ňou je fotka rozmazaná). */
const MIN_QUALITY = 0.4;

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/** Dekóduje obrázok so správnou orientáciou z EXIF; starší Safari nepozná voľby `createImageBitmap` → cez `<img>`. */
async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Pokračujeme cez <img> (ten v moderných prehliadačoch tiež rešpektuje EXIF orientáciu).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('decode'));
      image.src = url;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Zmenší vybranú fotku na štvorec PHOTO_SIZE_PX (orez zo stredu) a zakóduje ju do WebP; prehliadač bez WebP enkódera
 * (Safari vráti PNG) dostane JPEG. Ak je výsledok väčší ako PHOTO_MAX_BYTES, kvalita sa postupne znižuje.
 */
export async function compressPhoto(file: Blob): Promise<Blob> {
  let decoded: Decoded;
  try {
    decoded = await decode(file);
  } catch {
    throw new Error('Tento obrázok sa nedá otvoriť — skús JPEG alebo PNG.');
  }
  try {
    const side = Math.min(decoded.width, decoded.height);
    if (!side) {
      throw new Error('Tento obrázok sa nedá otvoriť — skús JPEG alebo PNG.');
    }
    const canvas = document.createElement('canvas');
    canvas.width = PHOTO_SIZE_PX;
    canvas.height = PHOTO_SIZE_PX;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Prehliadač nevie upraviť obrázok.');
    }
    // Plné pozadie — priehľadné PNG by v JPEG-u vyšlo čierne.
    context.fillStyle = '#12211b';
    context.fillRect(0, 0, PHOTO_SIZE_PX, PHOTO_SIZE_PX);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    const sourceX = (decoded.width - side) / 2;
    const sourceY = (decoded.height - side) / 2;
    context.drawImage(decoded.source, sourceX, sourceY, side, side, 0, 0, PHOTO_SIZE_PX, PHOTO_SIZE_PX);

    let type = 'image/webp';
    let quality = 0.82;
    let blob = await toBlob(canvas, type, quality);
    if (!blob || blob.type !== 'image/webp') {
      type = 'image/jpeg';
      quality = 0.85;
      blob = await toBlob(canvas, type, quality);
    }
    while (blob && blob.size > PHOTO_MAX_BYTES && quality > MIN_QUALITY) {
      quality = Math.max(MIN_QUALITY, Math.round((quality - 0.1) * 100) / 100);
      blob = await toBlob(canvas, type, quality);
    }
    if (!blob || blob.type !== type) {
      throw new Error('Prehliadač nevie uložiť obrázok.');
    }
    if (blob.size > PHOTO_MAX_BYTES) {
      throw new Error('Fotka je ani po zmenšení príliš veľká.');
    }
    return blob;
  } finally {
    decoded.release();
  }
}

/** Nahrá zmenšenú fotku na server; vráti aktualizovaný účet. */
export async function uploadPhoto(photo: Blob): Promise<Ack<AccountView>> {
  const token = authToken();
  if (!token) {
    return { ok: false, error: 'Nie si prihlásený' };
  }
  try {
    const response = await fetch('/api/account/photo', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': photo.type },
      body: photo,
    });
    const result = (await response.json().catch(() => null)) as Ack<AccountView> | null;
    if (result && typeof result.ok === 'boolean') {
      return result;
    }
    return { ok: false, error: response.status === 413 ? 'Fotka je príliš veľká' : `Fotku sa nepodarilo nahrať (${response.status})` };
  } catch {
    return { ok: false, error: NO_RESPONSE };
  }
}
