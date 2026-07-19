import { cep_node, cep, __adobe_cep__ } from "./lib/cep-types";
import type { ChromaRelayDebugApi } from "./shared/debug-api";

declare module "*.png";
declare module "*.gif";
declare module "*.jpg";
declare module "*.svg";

declare global {
  interface Window {
    cep_node: cep_node;
    cep: cep;
    __adobe_cep__: __adobe_cep__;
    __CHROMA_RELAY_DEBUG__?: ChromaRelayDebugApi;
  }
}
