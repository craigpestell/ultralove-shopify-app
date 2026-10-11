export class ListingPolicyError extends Error {}

export type ListingPolicy = {
  mode: "KEEP" | "UPDATE";
  content: boolean;
  images: boolean;
  prices: boolean;
  links: Record<string, string>;
  recreate: number[];
};

export function defaultListingPolicy(): ListingPolicy {
  return { mode: "KEEP", content: false, images: false, prices: false, links: {}, recreate: [] };
}

export function listingPolicy(value: unknown, ids: number[]): ListingPolicy {
  if (value === undefined) return defaultListingPolicy();
  const invalid = () => { throw new ListingPolicyError("Invalid listing policy. Review the selected fields, links and replacements."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  const keys = ["mode", "content", "images", "prices", "links", "recreate"];
  if (Object.keys(input).length !== keys.length || Object.keys(input).some((key) => !keys.includes(key)) ||
      !(input.mode === "KEEP" || input.mode === "UPDATE") ||
      ["content", "images", "prices"].some((key) => typeof input[key] !== "boolean") ||
      !input.links || typeof input.links !== "object" || Array.isArray(input.links) ||
      !Array.isArray(input.recreate)) return invalid();
  if (input.mode === "UPDATE" && !(input.content || input.images || input.prices)) return invalid();
  const links: Record<string, string> = {};
  const selected = new Set(ids.map(String));
  for (const [key, target] of Object.entries(input.links)) {
    if (!selected.has(key) || !/^[1-9]\d*$/.test(key) ||
        typeof target !== "string" || !/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(target)) return invalid();
    links[key] = target;
  }
  const recreate = input.recreate as unknown[];
  if (recreate.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || !ids.includes(id) || links[String(id)]) ||
      new Set(recreate).size !== recreate.length || new Set(Object.values(links)).size !== Object.keys(links).length) return invalid();
  return { mode: input.mode as ListingPolicy["mode"], content: input.content as boolean,
    images: input.images as boolean, prices: input.prices as boolean, links, recreate: [...recreate as number[]].sort((a, b) => a - b) };
}

export function listingSignature(value: ListingPolicy): string {
  return JSON.stringify({ mode: value.mode, content: value.content, images: value.images, prices: value.prices,
    links: Object.fromEntries(Object.entries(value.links).sort(([a], [b]) => Number(a) - Number(b))),
    recreate: [...value.recreate].sort((a, b) => a - b) });
}
