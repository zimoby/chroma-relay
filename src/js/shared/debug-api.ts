import { version } from "../../../package.json";
import contract from "../../shared/product-contract.json" with { type: "json" };

export const BUILD_MARKER = `${contract.marker.current} · ${version}`;

export type PanelPage = "main" | "settings";

export type DebugColor = {
  id: string;
  css: string;
};

export type DebugPaletteColor = {
  id: string;
  rgba: [number, number, number, number];
};

export type FixtureViewport = {
  width: number;
  height: number;
};

export type DesignPreviewState =
  | "default"
  | "interaction"
  | "empty"
  | "disabled"
  | "error";

export type DebugCounters = {
  diskWrites: number;
  emittedEvents: number;
  receivedEvents: number;
  hostCalls: number;
};

export type DebugRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DebugGeometry = {
  panel: DebugRect | null;
  controls: Record<string, DebugRect>;
};

export type DebugIdentity = {
  extensionId: string;
  page: PanelPage;
  version: string;
  buildMarker: string;
  url: string;
  configRoot: string | null;
  scripts: string[];
  styles: string[];
};

export interface ChromaRelayDebugApi {
  getIdentity(): DebugIdentity;
  getState(): unknown;
  seedPalette(colors: DebugColor[]): boolean;
  persistPalette(colors: DebugPaletteColor[]): Promise<boolean>;
  reloadPalette(): unknown;
  setTemporaryConfigRoot(root: string | null): string | null;
  setFixtureViewport(width: number, height: number): boolean;
  setDesignPreview(state: DesignPreviewState): boolean;
  getGeometry(): DebugGeometry;
  getCounters(): DebugCounters;
  dispatchClick(testId: string): boolean;
  resetTestState(): void;
  reload(): void;
}

const FIXTURE_VIEWPORTS = new Set([
  "128x32",
  "160x32",
  "128x160",
  "200x200",
]);
const POSIX_TEMPORARY_CONFIG_ROOT =
  /^\/(?:private\/)?tmp\/chroma-relay-[a-zA-Z0-9._-]+$/;
const WINDOWS_TEMPORARY_CONFIG_ROOT =
  /^[a-zA-Z]:[\\/]Users[\\/][^\\/]+[\\/]AppData[\\/]Local[\\/]Temp[\\/]chroma-relay-[a-zA-Z0-9._-]+$/i;

const toRect = (element: Element | null): DebugRect | null => {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
};

export const isFixtureViewport = (width: number, height: number) =>
  FIXTURE_VIEWPORTS.has(`${width}x${height}`);

export const normalizeTemporaryConfigRoot = (root: string | null) => {
  if (root === null) return null;
  const normalized = root.replace(/[\\/]+$/, "");
  if (
    !POSIX_TEMPORARY_CONFIG_ROOT.test(normalized) &&
    !WINDOWS_TEMPORARY_CONFIG_ROOT.test(normalized)
  ) {
    throw new Error(
      "Debug config roots must be a chroma-relay-* child of the supported macOS or Windows temp directory"
    );
  }
  return normalized;
};

export const getPanelIdentity = (
  page: PanelPage,
  configRoot: string | null
): DebugIdentity => ({
  extensionId: window.__adobe_cep__.getExtensionId(),
  page,
  version,
  buildMarker: BUILD_MARKER,
  url: window.location.href,
  configRoot,
  scripts: Array.from(document.scripts)
    .map((script) => script.src)
    .filter(Boolean),
  styles: Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
    .map((style) => style.href)
    .filter(Boolean),
});

export const getTestGeometry = (page: PanelPage): DebugGeometry => {
  const controls: Record<string, DebugRect> = {};
  document.querySelectorAll<HTMLElement>("[data-testid]").forEach((element) => {
    const testId = element.dataset.testid;
    if (testId) controls[testId] = toRect(element) as DebugRect;
  });
  return {
    panel: toRect(document.querySelector(`[data-page="${page}"]`)),
    controls,
  };
};

export const dispatchTestClick = (testId: string) => {
  if (!/^[a-z0-9-]+$/.test(testId)) return false;
  const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!element) return false;
  if (element instanceof HTMLButtonElement && element.disabled) return false;
  element.click();
  return true;
};

export const installDebugApi = (api: ChromaRelayDebugApi) => {
  if (import.meta.env.VITE_CHROMA_RELAY_DEBUG !== "true") return () => undefined;
  window.__CHROMA_RELAY_DEBUG__ = api;
  return () => {
    if (window.__CHROMA_RELAY_DEBUG__ === api) {
      delete window.__CHROMA_RELAY_DEBUG__;
    }
  };
};
