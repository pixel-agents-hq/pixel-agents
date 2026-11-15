/**
 * The UI's languages: every locale carries every English message, with the
 * same placeholders, and the locale matching and interpolation rules.
 */

import { describe, expect, it } from 'vitest';

import { interpolate, LOCALES, matchLocale, translate } from '../src/i18n/index.js';
import { en } from '../src/i18n/messages/en/index.js';
import { vi } from '../src/i18n/messages/vi/index.js';

const CATALOGS = { en, vi } as const;

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe('catalogs', () => {
  it('lists a catalog for every locale', () => {
    expect(Object.keys(CATALOGS).sort()).toEqual([...LOCALES].sort());
  });

  for (const locale of LOCALES) {
    if (locale === 'en') continue;
    const catalog = CATALOGS[locale] as unknown as Record<string, Record<string, string>>;

    it(`${locale} has exactly the English keys`, () => {
      for (const [ns, messages] of Object.entries(en)) {
        expect(Object.keys(catalog[ns] ?? {}).sort(), ns).toEqual(Object.keys(messages).sort());
      }
    });

    it(`${locale} keeps every placeholder`, () => {
      for (const [ns, messages] of Object.entries(en)) {
        for (const [key, text] of Object.entries(messages as Record<string, string>)) {
          const translated = catalog[ns]?.[key] ?? '';
          expect(placeholders(translated), `${ns}.${key}`).toEqual(placeholders(text));
          expect(translated.trim(), `${ns}.${key} is empty`).not.toBe('');
        }
      }
    });
  }
});

describe('matchLocale', () => {
  it('takes the first supported base language', () => {
    expect(matchLocale(['fr-FR', 'vi-VN', 'en'])).toBe('vi');
    expect(matchLocale(['en-US'])).toBe('en');
  });

  it('falls back to English', () => {
    expect(matchLocale(['ja-JP'])).toBe('en');
    expect(matchLocale([])).toBe('en');
  });
});

describe('interpolate', () => {
  it('fills known placeholders and leaves unknown ones', () => {
    expect(interpolate('{a} and {b}', { a: 1 })).toBe('1 and {b}');
  });
});

describe('translate', () => {
  it('reads the requested locale', () => {
    expect(translate('vi', 'common.cancel')).toBe('Hủy');
    expect(translate('en', 'common.cancel')).toBe('Cancel');
  });
});
