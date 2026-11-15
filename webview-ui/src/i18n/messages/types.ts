/** A translation of one namespace: every key of the English one, as a string. */
export type Strings<T> = { readonly [K in keyof T]: string };
