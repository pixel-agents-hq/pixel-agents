/** A JSON object: not null, not an array. The one guard for "an object off the wire or a file". */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
