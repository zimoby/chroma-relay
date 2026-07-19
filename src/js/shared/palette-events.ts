import CSInterface, { CSEvent } from "../lib/cep/csinterface";
import {
  MAX_PALETTE_COLORS,
  MAX_PALETTE_NAME_LENGTH,
  type PaletteDocument,
  type PaletteDropEdge,
  type PaletteImportItem,
  type Rgba,
  clonePaletteDocument,
  isPaletteDocument,
  isPaletteImportItem,
  isRgba,
} from "./palette-domain";

export const PALETTE_COMMAND_EVENT = "com.zimoby.chroma-relay.command";
export const PALETTE_RESULT_EVENT = "com.zimoby.chroma-relay.result";

export type PaletteCommand =
  | { type: "create" }
  | { type: "select"; paletteId: string }
  | { type: "rename"; paletteId: string; name: string }
  | { type: "delete"; paletteId: string }
  | { type: "import-palette"; name: string; items: PaletteImportItem[] }
  | { type: "add-color"; paletteId: string }
  | { type: "remove-color"; paletteId: string; colorId: string }
  | { type: "update-color"; paletteId: string; colorId: string; rgba: Rgba }
  | {
      type: "reorder-color";
      paletteId: string;
      sourceId: string;
      targetId: string;
      edge: PaletteDropEdge;
    };

export type PaletteCommandRequest = {
  requestId: string;
  baseRevision: number;
  command: PaletteCommand;
};

export type PaletteCommandResult = {
  requestId: string | null;
  ok: boolean;
  message: string;
  document: PaletteDocument;
};

const csi = new CSInterface();
const ENTITY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REQUEST_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;

const parseData = (data: unknown): unknown => {
  try {
    return typeof data === "string" ? (JSON.parse(data) as unknown) : data;
  } catch {
    return null;
  }
};

const isEntityId = (value: unknown): value is string =>
  typeof value === "string" && ENTITY_ID.test(value);

const isPaletteCommand = (value: unknown): value is PaletteCommand => {
  if (!value || typeof value !== "object") return false;
  const command = value as Partial<PaletteCommand> & Record<string, unknown>;
  switch (command.type) {
    case "create":
      return true;
    case "select":
    case "delete":
      return isEntityId(command.paletteId);
    case "rename":
      return (
        isEntityId(command.paletteId) &&
        typeof command.name === "string" &&
        command.name.length <= 256
      );
    case "import-palette":
      return (
        typeof command.name === "string" &&
        command.name === command.name.trim() &&
        command.name.length > 0 &&
        command.name.length <= MAX_PALETTE_NAME_LENGTH &&
        Array.isArray(command.items) &&
        command.items.length <= MAX_PALETTE_COLORS &&
        command.items.every(isPaletteImportItem)
      );
    case "add-color":
      return isEntityId(command.paletteId);
    case "remove-color":
      return isEntityId(command.paletteId) && isEntityId(command.colorId);
    case "update-color":
      return (
        isEntityId(command.paletteId) &&
        isEntityId(command.colorId) &&
        isRgba(command.rgba)
      );
    case "reorder-color":
      return (
        isEntityId(command.paletteId) &&
        isEntityId(command.sourceId) &&
        isEntityId(command.targetId) &&
        (command.edge === "before" || command.edge === "after")
      );
    default:
      return false;
  }
};

const parseCommandRequest = (data: unknown): PaletteCommandRequest | null => {
  const parsed = parseData(data);
  if (!parsed || typeof parsed !== "object") return null;
  const request = parsed as Partial<PaletteCommandRequest>;
  if (
    typeof request.requestId !== "string" ||
    !REQUEST_ID.test(request.requestId) ||
    !Number.isInteger(request.baseRevision) ||
    (request.baseRevision as number) < 0 ||
    !isPaletteCommand(request.command)
  ) {
    return null;
  }
  return {
    requestId: request.requestId,
    baseRevision: request.baseRevision as number,
    command: request.command,
  };
};

const parseCommandResult = (data: unknown): PaletteCommandResult | null => {
  const parsed = parseData(data);
  if (!parsed || typeof parsed !== "object") return null;
  const result = parsed as Partial<PaletteCommandResult>;
  if (
    (result.requestId !== null &&
      (typeof result.requestId !== "string" || !REQUEST_ID.test(result.requestId))) ||
    typeof result.ok !== "boolean" ||
    typeof result.message !== "string" ||
    !isPaletteDocument(result.document)
  ) {
    return null;
  }
  return {
    requestId: result.requestId ?? null,
    ok: result.ok,
    message: result.message,
    document: clonePaletteDocument(result.document),
  };
};

const dispatchApplicationEvent = (eventName: string, data: unknown) => {
  const event = new CSEvent(
    eventName,
    "APPLICATION",
    csi.getApplicationID(),
    csi.getExtensionID()
  );
  event.data = data;
  csi.dispatchEvent(event);
};

export const dispatchPaletteCommand = (request: PaletteCommandRequest) => {
  dispatchApplicationEvent(PALETTE_COMMAND_EVENT, request);
};

export const dispatchPaletteResult = (result: PaletteCommandResult) => {
  dispatchApplicationEvent(PALETTE_RESULT_EVENT, {
    ...result,
    document: clonePaletteDocument(result.document),
  });
};

export const listenForPaletteCommands = (
  callback: (request: PaletteCommandRequest) => void
) => {
  const handler = (event: { data: unknown }) => {
    const request = parseCommandRequest(event.data);
    if (request) callback(request);
  };
  csi.addEventListener(PALETTE_COMMAND_EVENT, handler);
  return () => csi.removeEventListener(PALETTE_COMMAND_EVENT, handler, null);
};

export const listenForPaletteResults = (
  callback: (result: PaletteCommandResult) => void
) => {
  const handler = (event: { data: unknown }) => {
    const result = parseCommandResult(event.data);
    if (result) callback(result);
  };
  csi.addEventListener(PALETTE_RESULT_EVENT, handler);
  return () => csi.removeEventListener(PALETTE_RESULT_EVENT, handler, null);
};
