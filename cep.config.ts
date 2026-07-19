import type { CEP_Config } from "vite-cep-plugin";
import { version } from "./package.json";
import contract from "./src/shared/product-contract.json" with { type: "json" };

const config: CEP_Config = {
  version,
  id: contract.product.extensionId,
  displayName: contract.product.displayName,
  symlink: "local",
  port: 3000,
  servePort: 5000,
  startingDebugPort: 8198,
  extensionManifestVersion: contract.cep.manifestVersion,
  requiredRuntimeVersion: contract.cep.requiredRuntimeVersion,
  hosts: [
    { name: "AEFT", version: "[22.0,99.9]" },
  ],

  type: "Panel",
  iconDarkNormal: "./assets/chroma-relay-icon.png",
  iconNormal: "./assets/chroma-relay-icon.png",
  iconDarkNormalRollOver: "./assets/chroma-relay-icon.png",
  iconNormalRollOver: "./assets/chroma-relay-icon.png",
  parameters: ["--v=0", "--enable-nodejs", "--mixed-context"],
  width: 500,
  height: 550,

  panels: [
    {
      mainPath: "./main/index.html",
      name: "main",
      id: contract.product.panelIds.main,
      panelDisplayName: "Chroma Relay", 
      autoVisible: true,
      width: 320,
      height: 80,
      minWidth: 128,
      minHeight: 32,
    },
    {
      mainPath: "./settings/index.html",
      name: "settings",
      id: contract.product.panelIds.settings,
      panelDisplayName: "",
      autoVisible: false,
      width: 320,
      height: 280,
      minWidth: 280,
      minHeight: 220,
    },
  ],
  build: {
    jsxBin: "off",
    sourceMap: true,
  },
  zxp: {
    country: "US",
    province: "CA",
    org: "Company",
    password: process.env.ZXP_PASSWORD ?? "",
    tsa: [
      "http://timestamp.digicert.com/", // Windows Only
      "http://timestamp.apple.com/ts01", // MacOS Only
    ],
    allowSkipTSA: false,
    sourceMap: false,
    jsxBin: "off",
  },
  installModules: [],
  copyAssets: [
    "assets/chroma-relay-icon.png",
    "assets/native-gradient/ae25-6/fill-template.ffx",
    "assets/native-gradient/ae25-6/stroke-template.ffx",
  ],
  copyZipAssets: [],
};
export default config;
