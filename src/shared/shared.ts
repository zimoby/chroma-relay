import { version as packageVersion } from "../../package.json";
import contract from "./product-contract.json" with { type: "json" };

export const ns = contract.product.extensionId;
export const company = "Company";
export const displayName = contract.product.displayName;
export const version = packageVersion;
