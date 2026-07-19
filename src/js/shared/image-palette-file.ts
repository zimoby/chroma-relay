import { fs, path } from "../lib/cep/node.ts";
import type { ExtractionPreset } from "./layout-settings-domain.ts";
import {
  extractPaletteFromRgba,
  type ImagePaletteExtractionResult,
} from "./image-palette-domain.ts";

export const MAX_EXTRACTION_PIXELS = 65_536;
export const MAX_IMAGE_FILE_BYTES = 32 * 1024 * 1024;

export type ImageFileStat = {
  size: number;
  dev?: number;
  ino?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
};

export type ImageFileIo = {
  lstatSync: (filePath: string) => ImageFileStat;
  openSync: (filePath: string, flags: number) => number;
  fstatSync: (fd: number) => ImageFileStat;
  readSync: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ) => number;
  closeSync: (fd: number) => void;
  constants?: {
    O_RDONLY?: unknown;
    O_NONBLOCK?: unknown;
    O_NOFOLLOW?: unknown;
  };
};

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

const sameFileIdentity = (before: ImageFileStat, after: ImageFileStat) =>
  before.size === after.size &&
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.mtimeMs === after.mtimeMs &&
  before.ctimeMs === after.ctimeMs;

const getImageOpenFlags = (io: ImageFileIo) => {
  const constants = io.constants;
  let flags = typeof constants?.O_RDONLY === "number" ? constants.O_RDONLY : 0;
  if (typeof constants?.O_NONBLOCK === "number") flags |= constants.O_NONBLOCK;
  if (typeof constants?.O_NOFOLLOW === "number") flags |= constants.O_NOFOLLOW;
  return flags;
};

export const readBoundedImageFile = (
  filePath: string,
  io: ImageFileIo = fs as ImageFileIo
) => {
  let pathBefore: ImageFileStat;
  try {
    pathBefore = io.lstatSync(filePath);
  } catch {
    throw new Error("Selected image file no longer exists");
  }
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    throw new Error("Selected image must be a regular file, not a directory or symbolic link");
  }
  let descriptor: number | null = null;
  try {
    descriptor = io.openSync(filePath, getImageOpenFlags(io));
    let pathAfterOpen: ImageFileStat;
    try {
      pathAfterOpen = io.lstatSync(filePath);
    } catch {
      throw new Error("Selected image file changed while it was being read");
    }
    if (
      pathAfterOpen.isSymbolicLink() ||
      !pathAfterOpen.isFile() ||
      !sameFileIdentity(pathBefore, pathAfterOpen)
    ) {
      throw new Error("Selected image file changed while it was being read");
    }
    const descriptorBefore = io.fstatSync(descriptor);
    if (!descriptorBefore.isFile() || !sameFileIdentity(pathBefore, descriptorBefore)) {
      throw new Error("Selected image file changed while it was being opened");
    }
    if (!Number.isSafeInteger(descriptorBefore.size) || descriptorBefore.size < 0) {
      throw new Error("Selected image file size is invalid");
    }
    if (descriptorBefore.size > MAX_IMAGE_FILE_BYTES) {
      throw new Error("Selected image file exceeds the 32 MiB limit");
    }

    const bytes = new Uint8Array(descriptorBefore.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = io.readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (!Number.isInteger(count) || count <= 0 || count > bytes.byteLength - offset) {
        throw new Error("Selected image file changed while it was being read");
      }
      offset += count;
    }

    const growthProbe = new Uint8Array(1);
    const extraBytes = io.readSync(descriptor, growthProbe, 0, 1, bytes.byteLength);
    if (extraBytes > 0) {
      throw new Error("Selected image file grew beyond its pinned size");
    }

    const descriptorAfter = io.fstatSync(descriptor);
    let pathAfter: ImageFileStat;
    try {
      pathAfter = io.lstatSync(filePath);
    } catch {
      throw new Error("Selected image file changed while it was being read");
    }
    if (
      !descriptorAfter.isFile() ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      !sameFileIdentity(descriptorBefore, descriptorAfter) ||
      !sameFileIdentity(pathBefore, pathAfter)
    ) {
      throw new Error("Selected image file changed while it was being read");
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Selected image")) throw error;
    throw new Error("Selected image file could not be read");
  } finally {
    if (descriptor !== null) io.closeSync(descriptor);
  }
};

export const extractPaletteFromImageFile = async (
  filePath: string,
  preset: ExtractionPreset,
  io: ImageFileIo = fs as ImageFileIo
): Promise<ImagePaletteExtractionResult> => {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES[extension];
  if (!mimeType) throw new Error("Selected image format is not supported");

  const bytes = readBoundedImageFile(filePath, io);
  const objectUrl = URL.createObjectURL(
    new Blob([bytes as unknown as BlobPart], { type: mimeType })
  );
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
