// Mask-image composite helper: punches the painted mask regions into the
// source image's alpha channel so ComfyUI reads them as mask value 1.0.
//
// Separated from FormField.tsx to keep that file from growing too large.

/**
 * Draw the source image onto a canvas, then use `destination-out` with the
 * painted mask overlay. The resulting PNG has alpha=0 where the mask was
 * painted — ComfyUI's LoadImage reads those pixels as mask=1 (inpaint here).
 */
export async function compositeMaskIntoImage(
  imageFile: File,
  maskDataUrl: string,
): Promise<File | null> {
  try {
    const img = await createImageBitmap(imageFile);
    const maskImg = new Image();
    await new Promise<void>((res, rej) => {
      maskImg.onload = () => res();
      maskImg.onerror = rej;
      maskImg.src = maskDataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) { img.close(); return null; }
    ctx.drawImage(img, 0, 0);
    img.close();
    // destination-out erases alpha where the mask has paint, leaving those
    // pixels transparent — ComfyUI's LoadImage reads transparency as mask=1.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(maskImg, 0, 0);
    const blob: Blob | null = await new Promise(r => canvas.toBlob(r, 'image/png'));
    if (!blob) return null;
    const name = imageFile.name.replace(/\.[^.]+$/, '') + '_masked.png';
    return new File([blob], name, { type: 'image/png' });
  } catch {
    return null;
  }
}
