/**
 * A fresh id minted on this machine: `prefix`, the time in base 36, `separator`, then
 * `randomChars` random base-36 characters (all of Math.random's when omitted). Not
 * crypto.randomUUID(): undefined on plain-http LAN origins (no secure context).
 */
export const newLocalId = (prefix: string, randomChars?: number, separator = ''): string =>
  `${prefix}${Date.now().toString(36)}${separator}${Math.random()
    .toString(36)
    .slice(2, randomChars === undefined ? undefined : 2 + randomChars)}`;
