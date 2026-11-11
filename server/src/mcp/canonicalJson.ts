/**
 * A value as one comparable string: JSON with object keys sorted and undefined
 * fields dropped, so two values that hold the same data compare equal whatever
 * order their keys were written in (what an agent edit wrote vs what is on disk
 * now: layoutEdits.ts, characterEdits.ts).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}
