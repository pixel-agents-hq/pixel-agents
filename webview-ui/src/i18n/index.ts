/**
 * The UI's languages. A deliberately small i18n: English is the source of
 * truth (`messages/en/*`), every other locale is typed against it (a missing
 * key fails typecheck), and `t('namespace.key', { var })` reads the current
 * locale, falling back to English. The choice is per browser (localStorage,
 * like the radio's), 'auto' following the browser/VS Code display language.
 *
 * `t` works outside React (DOM helpers, pure modules); components call
 * `useT()` so they re-render when the language changes.
 */

import { useSyncExternalStore } from 'react';

import { LANGUAGE_STORAGE_KEY } from '../constants.js';
import { en } from './messages/en/index.js';
import { vi } from './messages/vi/index.js';

type En = typeof en;
/** Every locale's shape: English's namespaces and keys, any string values. */
export type Messages = { readonly [N in keyof En]: { readonly [K in keyof En[N]]: string } };
/** A message id: `<namespace>.<key>`. */
export type MessageKey = {
  [N in keyof En]: `${N & string}.${keyof En[N] & string}`;
}[keyof En];
export type MessageVars = Readonly<Record<string, string | number>>;

export const LOCALES = ['en', 'vi'] as const;
export type Locale = (typeof LOCALES)[number];
export type LanguageChoice = Locale | 'auto';

/** Each locale's name, written in that language (what a picker shows). */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  en: 'English',
  vi: 'Tiếng Việt',
};

const CATALOGS: Readonly<Record<Locale, Messages>> = { en, vi };

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** The best locale for a list of BCP 47 tags ('vi-VN' → 'vi'), else English. */
export function matchLocale(tags: readonly string[]): Locale {
  for (const tag of tags) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return 'en';
}

function browserLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  return matchLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

function readChoice(): LanguageChoice {
  try {
    const raw = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLocale(raw) ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

let choice: LanguageChoice = readChoice();
let locale: Locale = choice === 'auto' ? browserLocale() : choice;
const listeners = new Set<() => void>();

function applyDocumentLang(): void {
  // Through globalThis: this module is also typechecked without the DOM lib (Node tests).
  const doc = (globalThis as { document?: { documentElement: { lang: string } } }).document;
  if (doc) doc.documentElement.lang = locale;
}
applyDocumentLang();

export function getLocale(): Locale {
  return locale;
}

export function getLanguageChoice(): LanguageChoice {
  return choice;
}

/** Sets this browser's language ('auto' = follow the browser) and re-renders every reader. */
export function setLanguageChoice(next: LanguageChoice): void {
  choice = next;
  try {
    if (next === 'auto') localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    else localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
  } catch {
    // Storage blocked (private window): the choice lasts this page only.
  }
  const resolved = next === 'auto' ? browserLocale() : next;
  if (resolved === locale) {
    // Same locale, but the picker still shows the new choice.
    listeners.forEach((l) => l());
    return;
  }
  locale = resolved;
  applyDocumentLang();
  listeners.forEach((l) => l());
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fills `{name}` placeholders; an unknown one stays as written. */
export function interpolate(template: string, vars?: MessageVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** A message in a given locale (English when that locale lacks it). */
export function translate(target: Locale, key: MessageKey, vars?: MessageVars): string {
  const dot = key.indexOf('.');
  const ns = key.slice(0, dot) as keyof Messages;
  const id = key.slice(dot + 1);
  const pick = (cat: Messages) => (cat[ns] as Record<string, string> | undefined)?.[id];
  return interpolate(pick(CATALOGS[target]) ?? pick(en) ?? key, vars);
}

/** A message in the current locale. */
export function t(key: MessageKey, vars?: MessageVars): string {
  return translate(locale, key, vars);
}

export type Translate = typeof t;

let snapshot = { locale, choice };
function getSnapshot() {
  if (snapshot.locale !== locale || snapshot.choice !== choice) snapshot = { locale, choice };
  return snapshot;
}

/** The current locale and choice, re-rendering on change. */
export function useLocale(): { locale: Locale; choice: LanguageChoice } {
  return useSyncExternalStore(subscribeLocale, getSnapshot, getSnapshot);
}

/** `t`, re-rendering the caller when the language changes. */
export function useT(): Translate {
  useLocale();
  return t;
}
