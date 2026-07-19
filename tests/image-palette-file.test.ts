import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const nodeRequire = createRequire(import.meta.url);
(globalThis as any).require = nodeRequire;
(globalThis as any).window = {
  cep: {},
  __adobe_cep__: {
    getApplicationID: () => "test-app",
    getExtensionID: () => "test-extension",
    getHostEnvironment: () => JSON.stringify({ appVersion: "25.6.0" }),
  },
};

const imageModule = await import("../src/js/shared/image-palette-file.ts");
const { MAX_IMAGE_FILE_BYTES, readBoundedImageFile } = imageModule;

const stat = (overrides: Record<string, unknown> = {}) => ({
  size: 12,
  dev: 1,
  ino: 2,
  mtimeMs: 3,
  ctimeMs: 4,
  isFile: () => true,
  isSymbolicLink: () => false,
  ...overrides,
});

const ioFor = ({
  pathStats,
  descriptorStats,
  bytes,
}: {
  pathStats: any[];
  descriptorStats: any[];
  bytes: Uint8Array;
}) => {
  const events: string[] = [];
  const readPositions: number[] = [];
  let reads = 0;
  let opens = 0;
  let closes = 0;
  return {
    constants: { O_RDONLY: 0, O_NONBLOCK: 0x800, O_NOFOLLOW: 0x100 },
    events,
    readPositions,
    get reads() {
      return reads;
    },
    get opens() {
      return opens;
    },
    get closes() {
      return closes;
    },
    lstatSync() {
      events.push("lstat");
      const next = pathStats.shift();
      if (!next) throw new Error("unexpected path stat");
      return next;
    },
    openSync(_filePath: string, flags: number) {
      events.push("open");
      assert.equal(typeof flags, "number");
      assert.equal(flags & 0x800, 0x800);
      assert.equal(flags & 0x100, 0x100);
      opens += 1;
      return 7;
    },
    fstatSync() {
      events.push("fstat");
      const next = descriptorStats.shift();
      if (!next) throw new Error("unexpected descriptor stat");
      return next;
    },
    readSync(_fd: number, buffer: Uint8Array, offset: number, length: number, position: number) {
      events.push("read");
      readPositions.push(position);
      reads += 1;
      const chunk = bytes.subarray(position, Math.min(position + length, bytes.byteLength));
      buffer.set(chunk, offset);
      return chunk.byteLength;
    },
    closeSync() {
      events.push("close");
      closes += 1;
    },
  };
};

test("bounded image input rejects missing, directory, symlink, and oversized paths before read", () => {
  const cases = [
    ["missing", undefined, /does not exist|no longer exists/i],
    ["directory", stat({ isFile: () => false }), /regular file|directory/i],
    ["symlink", stat({ isSymbolicLink: () => true }), /symbolic link|regular file/i],
    ["oversized", stat({ size: MAX_IMAGE_FILE_BYTES + 1 }), /32 MiB|too large|limit/i],
  ] as const;
  for (const [label, before, error] of cases) {
    const io =
      before === undefined
        ? { lstatSync: () => { throw new Error("ENOENT"); }, readFileSync() { throw new Error("read"); } }
        : ioFor({
            pathStats: [before, before],
            descriptorStats: [before],
            bytes: new Uint8Array(),
          });
    assert.throws(() => readBoundedImageFile(`/tmp/${label}.png`, io), error);
    assert.equal(io.reads ?? 0, 0, `${label} must fail before descriptor read`);
  }
});

test("bounded image input rejects a file changed during read and accepts a stable regular file", () => {
  const changed = ioFor({
    pathStats: [stat({ size: 3 }), stat({ size: 3 }), stat({ size: 3 })],
    descriptorStats: [stat({ size: 3 }), stat({ size: 3, mtimeMs: 99 })],
    bytes: Uint8Array.from([1, 2, 3]),
  });
  assert.throws(
    () => readBoundedImageFile("/tmp/changed.png", changed),
    /changed while it was being read/i
  );
  assert.ok(changed.reads >= 2);
  assert.equal(changed.closes, 1);

  const bytes = Uint8Array.from([5, 6, 7]);
  const stable = ioFor({
    pathStats: [stat({ size: bytes.byteLength }), stat({ size: bytes.byteLength }), stat({ size: bytes.byteLength })],
    descriptorStats: [stat({ size: bytes.byteLength }), stat({ size: bytes.byteLength })],
    bytes,
  });
  assert.deepEqual(readBoundedImageFile("/tmp/stable.png", stable), bytes);
  assert.ok(stable.reads >= 2);
  assert.equal(stable.opens, 1);
  assert.equal(stable.closes, 1);
});

test("bounded image input rejects path replacement and same-inode symlink before descriptor reads", () => {
  const fullReplacementBytes = Uint8Array.from({ length: 12 }, (_, index) => index + 1);
  const replaced = ioFor({
    pathStats: [stat(), stat({ ino: 99 }), stat({ ino: 99 })],
    descriptorStats: [stat({ ino: 99 })],
    bytes: fullReplacementBytes,
  });
  assert.throws(
    () => readBoundedImageFile("/tmp/replaced.png", replaced),
    /changed while it was being read/i
  );
  assert.deepEqual(replaced.events.slice(0, 3), ["lstat", "open", "lstat"]);
  assert.equal(replaced.reads, 0);
  assert.equal(replaced.closes, 1);

  const symlink = ioFor({
    pathStats: [stat(), stat({ isSymbolicLink: () => true }), stat({ isSymbolicLink: () => true })],
    descriptorStats: [stat(), stat()],
    bytes: fullReplacementBytes,
  });
  assert.throws(
    () => readBoundedImageFile("/tmp/symlink.png", symlink),
    /changed while it was being read|symbolic link/i
  );
  assert.equal(symlink.reads, 0);
  assert.equal(symlink.closes, 1);
});

test("bounded image input rejects a real appended growth byte beyond the pinned size", () => {
  const initialBytes = Uint8Array.from([1, 2, 3]);
  const grown = ioFor({
    pathStats: [stat({ size: initialBytes.byteLength }), stat({ size: initialBytes.byteLength }), stat({ size: initialBytes.byteLength })],
    descriptorStats: [stat({ size: initialBytes.byteLength }), stat({ size: initialBytes.byteLength })],
    bytes: Uint8Array.from([...initialBytes, 4]),
  });
  assert.throws(
    () => readBoundedImageFile("/tmp/grown.png", grown),
    /changed while it was being read|grew/i
  );
  assert.deepEqual(grown.readPositions, [0, 3]);
  assert.equal(grown.closes, 1);
});

test("decode and canvas failures always revoke their object URLs", async () => {
  const originalImage = (globalThis as any).Image;
  const originalDocument = (globalThis as any).document;
  const originalUrl = (globalThis as any).URL;
  const created: string[] = [];
  const revoked: string[] = [];
  try {
    (globalThis as any).URL = {
      createObjectURL() {
        const objectUrl = `blob:test-${created.length}`;
        created.push(objectUrl);
        return objectUrl;
      },
      revokeObjectURL(objectUrl: string) {
        revoked.push(objectUrl);
      },
    };
    (globalThis as any).Image = class {
      naturalWidth = 2;
      naturalHeight = 2;
      onload: (() => void) | null = null;
      onerror: ((error: unknown) => void) | null = null;
      set src(value: string) {
        if (value.endsWith("0")) queueMicrotask(() => this.onerror?.(new Error("decode")));
        else queueMicrotask(() => this.onload?.());
      }
    };
    (globalThis as any).document = {
      createElement() {
        return {
          width: 0,
          height: 0,
          getContext() {
            return {
              drawImage() {
                throw new Error("canvas failure");
              },
            };
          },
        };
      },
    };
    const makeDecodeIo = () =>
      ioFor({
        pathStats: [stat({ size: 3 }), stat({ size: 3 }), stat({ size: 3 })],
        descriptorStats: [stat({ size: 3 }), stat({ size: 3 })],
        bytes: Uint8Array.from([1, 2, 3]),
      });
    await assert.rejects(
      imageModule.extractPaletteFromImageFile("/tmp/decode.png", "balanced", makeDecodeIo()),
      /decode/i
    );
    await assert.rejects(
      imageModule.extractPaletteFromImageFile("/tmp/canvas.png", "balanced", makeDecodeIo()),
      /canvas failure/i
    );
    assert.deepEqual(revoked, created);
  } finally {
    (globalThis as any).Image = originalImage;
    (globalThis as any).document = originalDocument;
    (globalThis as any).URL = originalUrl;
  }
});
