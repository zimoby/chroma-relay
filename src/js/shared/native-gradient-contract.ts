export type NativeGradientApplyStatus =
  | "ok"
  | "unsupported-host-version"
  | "host-version-drift"
  | "invalid-request"
  | "invalid-preset"
  | "no-project"
  | "no-active-comp"
  | "no-selected-gradient"
  | "ambiguous-selected-gradient"
  | "unsupported-selected-gradient"
  | "target-drift"
  | "selection-snapshot-failed"
  | "undo-open-failed"
  | "selection-mutation-failed"
  | "apply-unknown-completion"
  | "selection-restore-failed"
  | "undo-close-failed"
  | "finalization-failed";

export type NativeGradientTemplateFamily = "ae25-6";

const HOST_PRODUCT_VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?$/;

export const normalizeNativeGradientHostVersion = (hostVersion: string): string | null => {
  const normalized = hostVersion.replace(/x\d+$/, "");
  return HOST_PRODUCT_VERSION_PATTERN.test(normalized) ? normalized : null;
};

export const resolveNativeGradientTemplateFamily = (
  hostVersion: string
): NativeGradientTemplateFamily | null => {
  const normalized = normalizeNativeGradientHostVersion(hostVersion);
  return normalized !== null && /^25\.6(?:\.\d+)?$/.test(normalized) ? "ae25-6" : null;
};
