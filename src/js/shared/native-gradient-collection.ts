import {
  indexAepNativeGradientTargets,
  parseRifx,
  resolveAepNativeGradientTarget,
  validateGeneratedGradient,
  type AepNativeGradientTargetDescriptor,
  type ImmutableGradientAlphaStop,
  type ImmutableNativeGradient,
  type NativeGradient,
} from "@zimoby/ae-native-gradient";
import { fs } from "../lib/cep/node.ts";
import type { Rgba } from "./palette-domain";

const MAX_AEP_BYTES = 256 * 1024 * 1024;

export type HostNativeGradientTargetDescriptor = AepNativeGradientTargetDescriptor &
  Readonly<{
    projectPath: string;
    projectDirty: false;
  }>;

type NativeGradientCollectionErrorCode =
  | "invalid-descriptors"
  | "project-read-failed"
  | "project-changed"
  | "target-not-resolved"
  | "target-ambiguous"
  | "gradient-invalid"
  | "alpha-ambiguous";

export class NativeGradientCollectionError extends Error {
  readonly code: NativeGradientCollectionErrorCode;

  constructor(code: NativeGradientCollectionErrorCode, message: string) {
    super(message);
    this.name = "NativeGradientCollectionError";
    this.code = code;
  }
}

type AlphaGroup = {
  offset: number;
  alpha: number | null;
};

const groupedAlphaStops = (stops: readonly ImmutableGradientAlphaStop[]): AlphaGroup[] => {
  if (stops.length === 0) {
    throw new NativeGradientCollectionError("gradient-invalid", "Gradient has no alpha stops");
  }
  const groups: AlphaGroup[] = [];
  let previousOffset = -Infinity;
  stops.forEach((stop) => {
    if (
      !Number.isFinite(stop.offset) ||
      stop.offset < 0 ||
      stop.offset > 1 ||
      stop.offset < previousOffset ||
      !Number.isFinite(stop.alpha) ||
      stop.alpha < 0 ||
      stop.alpha > 1
    ) {
      throw new NativeGradientCollectionError("gradient-invalid", "Gradient alpha stops are invalid");
    }
    previousOffset = stop.offset;
    const current = groups[groups.length - 1];
    if (!current || current.offset !== stop.offset) {
      groups.push({ offset: stop.offset, alpha: stop.alpha });
      return;
    }
    if (current.alpha !== stop.alpha) current.alpha = null;
  });
  return groups;
};

const requiredAlpha = (group: AlphaGroup) => {
  if (group.alpha === null) {
    throw new NativeGradientCollectionError(
      "alpha-ambiguous",
      `Gradient alpha is ambiguous at offset ${group.offset}`
    );
  }
  return group.alpha;
};

export const alphaAtGradientOffset = (
  stops: readonly ImmutableGradientAlphaStop[],
  offset: number
): number => {
  if (!Number.isFinite(offset) || offset < 0 || offset > 1) {
    throw new NativeGradientCollectionError("gradient-invalid", "Gradient color offset is invalid");
  }
  const groups = groupedAlphaStops(stops);
  if (offset <= groups[0].offset) return requiredAlpha(groups[0]);
  const last = groups[groups.length - 1];
  if (offset >= last.offset) return requiredAlpha(last);

  for (let index = 1; index < groups.length; index += 1) {
    const upper = groups[index];
    if (offset > upper.offset) continue;
    if (offset === upper.offset) return requiredAlpha(upper);
    const lower = groups[index - 1];
    const lowerAlpha = requiredAlpha(lower);
    const upperAlpha = requiredAlpha(upper);
    const progress = (offset - lower.offset) / (upper.offset - lower.offset);
    return lowerAlpha + (upperAlpha - lowerAlpha) * progress;
  }
  throw new NativeGradientCollectionError("gradient-invalid", "Gradient alpha could not be derived");
};

export const nativeGradientToPaletteColors = (
  gradient: ImmutableNativeGradient
): Rgba[] => {
  if (gradient.colorStops.length === 0) {
    throw new NativeGradientCollectionError("gradient-invalid", "Gradient has no color stops");
  }
  return gradient.colorStops.map((stop) => {
    if (
      !Number.isFinite(stop.offset) ||
      stop.offset < 0 ||
      stop.offset > 1 ||
      stop.rgb.length !== 3 ||
      !stop.rgb.every(Number.isFinite)
    ) {
      throw new NativeGradientCollectionError("gradient-invalid", "Gradient color stops are invalid");
    }
    return [
      Math.fround(stop.rgb[0]),
      Math.fround(stop.rgb[1]),
      Math.fround(stop.rgb[2]),
      alphaAtGradientOffset(gradient.alphaStops, stop.offset),
    ];
  });
};

export const collectNativeGradientColorsFromAepBytes = (
  bytes: Uint8Array,
  descriptors: readonly HostNativeGradientTargetDescriptor[]
): Rgba[][] =>
  collectNativeGradientsFromAepBytes(bytes, descriptors).map(nativeGradientToPaletteColors);

export const collectNativeGradientsFromAepBytes = (
  bytes: Uint8Array,
  descriptors: readonly HostNativeGradientTargetDescriptor[]
): NativeGradient[] => {
  const document = parseRifx(bytes);
  const targets = indexAepNativeGradientTargets(document);
  return descriptors.map((descriptor) => {
    const resolution = resolveAepNativeGradientTarget(targets, descriptor);
    if (resolution.status === "none") {
      throw new NativeGradientCollectionError(
        "target-not-resolved",
        "Selected native gradient was not found exactly in the saved project"
      );
    }
    if (resolution.status === "ambiguous") {
      throw new NativeGradientCollectionError(
        "target-ambiguous",
        "Selected native gradient is ambiguous in the saved project"
      );
    }
    const candidate = resolution.target.candidate;
    if (candidate.status !== "valid") {
      throw new NativeGradientCollectionError("gradient-invalid", "Saved gradient payload is invalid");
    }
    try {
      return validateGeneratedGradient(candidate.gradient);
    } catch {
      throw new NativeGradientCollectionError("gradient-invalid", "Saved gradient payload is invalid");
    }
  });
};

const readStableAep = (filePath: string) => {
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = fs.openSync(filePath, "r");
    const before = fs.fstatSync(fileDescriptor);
    if (!before.isFile() || before.size <= 0 || before.size > MAX_AEP_BYTES) {
      throw new Error("project path is not one bounded regular file");
    }
    const bytes = new Uint8Array(before.size + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.byteLength) {
      const count = fs.readSync(
        fileDescriptor,
        bytes,
        bytesRead,
        bytes.byteLength - bytesRead,
        bytesRead
      );
      if (count === 0) break;
      bytesRead += count;
    }
    const after = fs.fstatSync(fileDescriptor);
    const pathAfter = fs.statSync(filePath);
    if (
      bytesRead !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      pathAfter.size !== after.size ||
      pathAfter.mtimeMs !== after.mtimeMs ||
      pathAfter.ctimeMs !== after.ctimeMs
    ) {
      throw new NativeGradientCollectionError(
        "project-changed",
        "Saved project changed while native gradients were being read"
      );
    }
    return bytes.slice(0, before.size);
  } catch (error) {
    if (error instanceof NativeGradientCollectionError) throw error;
    throw new NativeGradientCollectionError(
      "project-read-failed",
      "Saved project could not be read safely"
    );
  } finally {
    if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
  }
};

export const collectNativeGradientColorsFromProject = (
  descriptors: readonly HostNativeGradientTargetDescriptor[]
): Rgba[][] =>
  collectNativeGradientsFromProject(descriptors).map(nativeGradientToPaletteColors);

export const collectNativeGradientsFromProject = (
  descriptors: readonly HostNativeGradientTargetDescriptor[]
): NativeGradient[] => {
  if (descriptors.length === 0) return [];
  const projectPath = descriptors[0].projectPath;
  if (
    typeof projectPath !== "string" ||
    projectPath.length === 0 ||
    descriptors.some(
      (descriptor) => descriptor.projectDirty !== false || descriptor.projectPath !== projectPath
    )
  ) {
    throw new NativeGradientCollectionError(
      "invalid-descriptors",
      "Native gradient descriptors do not share one clean saved project"
    );
  }
  return collectNativeGradientsFromAepBytes(readStableAep(projectPath), descriptors);
};
