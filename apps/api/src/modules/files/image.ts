import sharp from 'sharp';
import type { Sharp, SharpOptions } from 'sharp';

/**
 * SEC8-016: every sharp pipeline sets `limitInputPixels` explicitly instead of relying on sharp's default (268 MP).
 * 50 MP covers any real photo or scan (a 48 MP phone camera is 8000 × 6000) while bounding the memory a
 * decompression bomb can make libvips allocate.
 */
export const MAX_IMAGE_PIXELS = 50_000_000;

/** `sharp(input, options)` with the pixel limit applied (callers may lower it, never raise it). */
export function decodeImage(input: Buffer, options: SharpOptions = {}): Sharp {
  const limit = typeof options.limitInputPixels === 'number' && options.limitInputPixels > 0 ? Math.min(options.limitInputPixels, MAX_IMAGE_PIXELS) : MAX_IMAGE_PIXELS;
  return sharp(input, { ...options, limitInputPixels: limit });
}
