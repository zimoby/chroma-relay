import packageJson from "../../package.json" with { type: "json" };
import contract from "../../src/shared/product-contract.json" with { type: "json" };
import {
  CdpClient,
  authenticateRuntime,
  discoverCdpTargets,
  selectCanonicalTarget,
} from "@zimoby/cep-testkit/cdp";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUILD_ROOT = resolve(REPO_ROOT, "dist/cep");
const EXPECTED_BUILD_MARKER = `${contract.marker.current} · ${packageJson.version}`;

const panel = (page) => Object.freeze({
  page,
  port: page === "main" ? 8198 : 8199,
  extensionId: contract.product.panelIds[page],
  expectedEntryPath: resolve(BUILD_ROOT, page, "index.html"),
});

export const CHROMA_PANELS = Object.freeze({
  main: panel("main"),
  settings: panel("settings"),
});

const readyProbe = `(() => {
  const api = window.__CHROMA_RELAY_DEBUG__;
  return document.readyState === "complete" && Boolean(api);
})()`;

const identityProbe = `(() => {
  const api = window.__CHROMA_RELAY_DEBUG__;
  if (!api) throw new Error("__CHROMA_RELAY_DEBUG__ is missing");
  return api.getIdentity();
})()`;

const reload = async (bootstrap) => {
  await bootstrap.send("Page.reload", { ignoreCache: true }).wait();
};

const waitReady = async (bootstrap) => {
  const ready = await bootstrap.evaluate(readyProbe).wait();
  if (ready !== true) throw new Error("Chroma Relay runtime is not ready");
};

const readChromaBuild = (panelSpec) => async (bootstrap, runtime) => {
  const ready = await bootstrap.evaluate(readyProbe).wait();
  if (ready !== true) throw new Error(`${panelSpec.page} Chroma Relay readiness probe failed`);

  const identity = await bootstrap.evaluate(identityProbe).wait();
  if (!identity || typeof identity !== "object") {
    throw new Error(`${panelSpec.page} Chroma Relay identity probe returned no object`);
  }
  if (identity.extensionId !== panelSpec.extensionId || identity.page !== panelSpec.page) {
    throw new Error(`${panelSpec.page} Chroma Relay product identity mismatch`);
  }
  if (identity.url !== runtime.href) {
    throw new Error(`${panelSpec.page} Chroma Relay identity URL drifted from authenticated runtime`);
  }
  if (identity.version !== packageJson.version || identity.buildMarker !== EXPECTED_BUILD_MARKER) {
    throw new Error(`${panelSpec.page} Chroma Relay build identity mismatch`);
  }

  const scripts = Array.isArray(identity.scripts) ? identity.scripts : [];
  const styles = Array.isArray(identity.styles) ? identity.styles : [];
  return {
    version: identity.version,
    buildMarker: identity.buildMarker,
    scriptAssets: [...scripts, ...styles],
  };
};

const createRuntimeSpec = (panelSpec) => ({
  surfaceId: panelSpec.extensionId,
  expectedExtensionId: panelSpec.extensionId,
  expectedEntryPath: panelSpec.expectedEntryPath,
  expectedVersion: packageJson.version,
  expectedBuildMarker: EXPECTED_BUILD_MARKER,
  readBuild: readChromaBuild(panelSpec),
  reload,
  waitReady,
});

const publicTarget = (target) => Object.freeze({
  discoveryIndex: target.discoveryIndex,
  url: target.url,
});

export async function connectChromaPanel({
  page = "main",
  host = "127.0.0.1",
  port,
} = {}) {
  const panelSpec = CHROMA_PANELS[page];
  if (!panelSpec) throw new Error(`Unknown Chroma Relay panel: ${page}`);
  const effectivePort = port ?? panelSpec.port;
  const discovery = await discoverCdpTargets(host, effectivePort);
  const target = await selectCanonicalTarget(discovery, panelSpec.expectedEntryPath);
  const client = new CdpClient(target.webSocketDebuggerUrl);

  try {
    await client.connect();
    const authentication = await authenticateRuntime(client, createRuntimeSpec(panelSpec));
    let closed = false;
    let closePromise = null;
    const dispatch = (name, timeoutMs, callback) => {
      if (closed) throw new Error("Chroma Relay adoption session is closed");
      return authentication.session.run(name, timeoutMs, callback);
    };
    const close = () => {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = Promise.resolve().then(() => client.close());
      return closePromise;
    };

    return Object.freeze({
      panel: Object.freeze({ page: panelSpec.page, extensionId: panelSpec.extensionId }),
      target: publicTarget(target),
      identity: authentication.identity,
      dispatch,
      close,
    });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
