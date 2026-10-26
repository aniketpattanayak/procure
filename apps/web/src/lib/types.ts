/** Contract response types live in @procure/schema (responses.ts). This file only holds client helpers. */

/** Lists the contract returns either as an array or as a Page; accept both. */
export function asArray<T>(v: T[] | { data: T[] } | null | undefined): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : v.data;
}
