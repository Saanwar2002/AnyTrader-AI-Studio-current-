/**
 * Client-side image compression for property photos so uploaded data URLs stay
 * safely beneath the server's 200,000-char limit and Firestore's 1 MB doc cap.
 */
export async function compressPropertyImageFile(
  file: File,
  maxChars: number = 165_000,
  maxDimension: number = 1200
): Promise<string> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });

  if (!rawDataUrl) {
    throw new Error("Image file could not be read.");
  }

  // If already well below threshold, keep original
  if (rawDataUrl.length <= maxChars) {
    return rawDataUrl;
  }

  // Compress via offscreen canvas
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not decode image."));
    image.src = rawDataUrl;
  });

  let width = img.naturalWidth || img.width;
  let height = img.naturalHeight || img.height;
  if (width > maxDimension || height > maxDimension) {
    const scale = Math.min(maxDimension / width, maxDimension / height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Image compression is unavailable in this browser.");
  }

  const qualities = [0.8, 0.65, 0.5, 0.35];
  let currentWidth = width;
  let currentHeight = height;

  for (let pass = 0; pass < 3; pass++) {
    canvas.width = currentWidth;
    canvas.height = currentHeight;
    ctx.clearRect(0, 0, currentWidth, currentHeight);
    ctx.drawImage(img, 0, 0, currentWidth, currentHeight);

    for (const quality of qualities) {
      const compressed = canvas.toDataURL("image/jpeg", quality);
      if (compressed.length <= maxChars) {
        return compressed;
      }
    }
    currentWidth = Math.max(320, Math.round(currentWidth * 0.7));
    currentHeight = Math.max(240, Math.round(currentHeight * 0.7));
  }

  throw new Error(`${file.name} is too large even after compression. Please choose a smaller photo.`);
}
