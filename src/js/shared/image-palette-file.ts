import { fs, path } from "../lib/cep/node";
import type { ExtractionPreset } from "./layout-settings-domain";
import {
  extractPaletteFromRgba,
  type ImagePaletteExtractionResult,
} from "./image-palette-domain";

export const MAX_EXTRACTION_PIXELS = 65_536;

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

export const isSupportedImagePath = (filePath: string) =>
  Object.prototype.hasOwnProperty.call(IMAGE_MIME_TYPES, path.extname(filePath).toLowerCase());

export const getBoundedImageSize = (
  sourceWidth: number,
  sourceHeight: number,
  maxPixels = MAX_EXTRACTION_PIXELS
) => {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error("Selected image has invalid dimensions");
  }
  const scale = Math.min(1, Math.sqrt(maxPixels / (sourceWidth * sourceHeight)));
  return {
    width: Math.max(1, Math.floor(sourceWidth * scale)),
    height: Math.max(1, Math.floor(sourceHeight * scale)),
  };
};

const loadImage = (objectUrl: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Selected image could not be decoded"));
    image.src = objectUrl;
  });

export const extractPaletteFromImageFile = async (
  filePath: string,
  preset: ExtractionPreset
): Promise<ImagePaletteExtractionResult> => {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES[extension];
  if (!mimeType) throw new Error("Selected image format is not supported");
  if (!fs.existsSync(filePath)) throw new Error("Selected image file no longer exists");

  const bytes = Uint8Array.from(fs.readFileSync(filePath));
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  try {
    const image = await loadImage(objectUrl);
    const size = getBoundedImageSize(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Image canvas is unavailable");
    context.drawImage(image, 0, 0, size.width, size.height);
    const imageData = context.getImageData(0, 0, size.width, size.height);
    return await extractPaletteFromRgba(imageData.data, size.width, size.height, preset);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};
