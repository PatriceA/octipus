/**
 * Rasterise the companion's icon frames (`src/shared/companion-frames.ts`) for
 * surfaces that only take bitmaps: the tab icon (a PNG data URL) and the
 * desktop tray (PNG bytes over IPC). Results are cached per SVG and size —
 * an animation re-renders the same few frames all day.
 */

const cache = new Map<string, Promise<Blob>>();

function render(svg: string, size: number): Promise<Blob> {
  const key = `${size}:${svg}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const promise = new Promise<Blob>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      if (!context) return reject(new Error('no 2d canvas context for the companion icon'));
      context.drawImage(image, 0, 0, size, size);
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('companion icon did not encode'))), 'image/png');
    };
    image.onerror = () => reject(new Error('companion icon SVG did not load'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  // A failed render must not poison the cache for the next attempt.
  promise.catch(() => cache.delete(key));
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  cache.set(key, promise);
  return promise;
}

export async function iconDataUrl(svg: string, size = 32): Promise<string> {
  const blob = await render(svg, size);
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('companion icon could not be read'));
    reader.readAsDataURL(blob);
  });
}

export async function iconPngBytes(svg: string, size = 64): Promise<number[]> {
  const blob = await render(svg, size);
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}
