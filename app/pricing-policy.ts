export class PricingError extends Error {}
export type MarkupOverrides = Record<string, string>;

export function markupPercent(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?$/.test(value.trim()) ||
      Number(value) > 1000) throw new PricingError("Markup must be 0–1000 percent, with at most two decimal places.");
  return Number(value).toFixed(2);
}

export function markupOverrides(value: unknown, ids: number[]): MarkupOverrides {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).length > 50) throw new PricingError("Invalid per-product markup overrides.");
  const overrides: MarkupOverrides = {};
  for (const [id, markup] of Object.entries(value)) {
    if (!/^[1-9]\d*$/.test(id) || !ids.includes(Number(id))) {
      throw new PricingError("Markup overrides must belong to selected parent products.");
    }
    try {
      overrides[id] = markupPercent(markup);
    } catch {
      throw new PricingError(`Product #${id}: markup must be 0–1000 percent, with at most two decimal places.`);
    }
  }
  return overrides;
}

export function selectedOverrides(overrides: MarkupOverrides, ids: number[]): MarkupOverrides {
  return Object.fromEntries(ids.filter((id) => overrides[id] !== undefined).map((id) => [id, overrides[id]]));
}

export function retailPrice(wholesale: string | null, markup: string): string {
  const normalized = markupPercent(markup);
  const price = wholesale === null || wholesale === "" ? "0" : wholesale;
  if (price.length > 128 || !/^\d+(?:\.\d+)?$/.test(price)) throw new PricingError("Invalid supplier CAD price.");
  const [whole, fraction = ""] = price.split(".");
  const amount = BigInt(whole + fraction);
  const scale = 10n ** BigInt(fraction.length);
  const basisPoints = BigInt(normalized.replace(".", ""));
  const divisor = scale * 100n;
  const numerator = amount * (10000n + basisPoints);
  const rounded = (numerator + divisor / 2n) / divisor;
  return `${rounded / 100n}.${String(rounded % 100n).padStart(2, "0")}`;
}

export function pricingSignature(ids: number[], markup: string, overrides: MarkupOverrides): string {
  const normalized = (value: string) => { try { return markupPercent(value); } catch { return value; } };
  return JSON.stringify([ids.slice().sort((a, b) => a - b), normalized(markup),
    Object.entries(selectedOverrides(overrides, ids)).sort(([a], [b]) => Number(a) - Number(b)).map(([id, value]) => [id, normalized(value)])]);
}
