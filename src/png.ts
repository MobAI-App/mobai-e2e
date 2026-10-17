/** PNG helpers: dimensions off the header, and painting secure fields over. */

import { decode, encode } from 'fast-png';
import type { Rect } from './client.ts';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Reads the dimensions out of a PNG's IHDR chunk; undefined for anything else. */
export function readPngSize(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.byteLength < 24) return undefined;
  for (const [offset, byte] of PNG_SIGNATURE.entries()) {
    if (data[offset] !== byte) return undefined;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Paints every rect black, in image pixels; returns a new PNG. */
export function maskPng(data: Uint8Array, rects: readonly Rect[]): Uint8Array {
  if (rects.length === 0) return data;
  const image = decode(data);
  const channels = image.channels;
  const pixels = image.data;
  const max = image.depth === 16 ? 65535 : 255;
  for (const rect of rects) {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(image.width, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(image.height, Math.ceil(rect.y + rect.height));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const at = (y * image.width + x) * channels;
        for (let c = 0; c < channels; c += 1) {
          // Alpha stays opaque; colour channels go black.
          pixels[at + c] = c === channels - 1 && (channels === 2 || channels === 4) ? max : 0;
        }
      }
    }
  }
  return encode({ width: image.width, height: image.height, data: pixels, channels, depth: image.depth });
}
