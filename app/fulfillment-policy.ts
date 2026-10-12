export type FulfillmentMode = "CATALOG" | "DROPSHIPPING";
export type FulfillmentModes = Record<string, FulfillmentMode>;
export class FulfillmentError extends Error {}

export function fulfillmentMode(value: unknown): FulfillmentMode {
  if (value !== "CATALOG" && value !== "DROPSHIPPING") throw new FulfillmentError("Choose catalog-only or dropshipping fulfillment.");
  return value;
}

export function fulfillmentModes(value: unknown, ids: number[]): FulfillmentModes {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FulfillmentError("Invalid product fulfillment choices.");
  const modes: FulfillmentModes = {};
  const selected = new Set(ids);
  for (const [id, mode] of Object.entries(value)) {
    if (!/^[1-9]\d*$/.test(id) || !selected.has(Number(id))) throw new FulfillmentError("Fulfillment choices must belong to selected products.");
    const checked = fulfillmentMode(mode);
    if (checked !== "CATALOG") modes[id] = checked;
  }
  return modes;
}

export function modeFor(modes: FulfillmentModes, id: number): FulfillmentMode {
  return modes[id] ?? "CATALOG";
}

export function fulfillmentSignature(ids: number[], modes: FulfillmentModes) {
  const checked = fulfillmentModes(modes, ids);
  return JSON.stringify([...ids].sort((a, b) => a - b).map((id) => [id, modeFor(checked, id)]));
}

export function fulfillmentLabel(mode: FulfillmentMode) {
  return mode === "CATALOG" ? "Catalog only — my own stock" : "Dropshipping — supplier inventory";
}
