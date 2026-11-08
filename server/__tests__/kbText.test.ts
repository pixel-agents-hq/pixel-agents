import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normalizeTitle } from '../src/kbIds.js';
import { checkContent } from '../src/kbProposals.js';
import type { KbStore } from '../src/kbStore.js';
import { checkPrivateDirectory, StorageUnsafeError } from '../src/privateStorage.js';
import { decodeRoleContent } from '../src/roles.js';
import { RoleStorageUnsafeError } from '../src/roleStorage.js';
import {
  decodeSafeText,
  hasInvisibleCharacter,
  INVISIBLE_CHARACTER,
  isWellFormedText,
} from '../src/textSafety.js';
import {
  proposer,
  seedEntries,
  singleStore,
  submitCreate,
  type TempHome,
  useTempHome,
  WS,
} from './kbHarness.js';

describe('shared extraction (S1b behaviour unchanged)', () => {
  let temp: TempHome;
  beforeEach(() => {
    temp = useTempHome();
  });
  afterEach(() => temp.restore());

  it('RoleStorageUnsafeError and StorageUnsafeError are the very same class object', async () => {
    expect(RoleStorageUnsafeError).toBe(StorageUnsafeError);
    const dir = path.join(temp.home, 'loose');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    const err = await checkPrivateDirectory(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoleStorageUnsafeError);
    expect(err).toBeInstanceOf(StorageUnsafeError);
    expect((err as Error).message).toBe('not a private directory');
  });

  it('decodeRoleContent is the shared decodeSafeText', () => {
    expect(decodeRoleContent).toBe(decodeSafeText);
  });
});

describe('isWellFormedText and hasInvisibleCharacter', () => {
  it('rejects lone surrogates and accepts real emoji without ES2024 isWellFormed', () => {
    expect(isWellFormedText('\uD800')).toBe(false);
    expect(isWellFormedText('\uDC00')).toBe(false);
    expect(isWellFormedText('a\uD800b')).toBe(false);
    expect(isWellFormedText('\uDC00\uD800')).toBe(false);
    expect(isWellFormedText('😀')).toBe(true);
    expect(isWellFormedText('👨‍👩‍👧')).toBe(true);
    expect(isWellFormedText('plain')).toBe(true);
  });

  it('answers the same on repeated calls (no lastIndex carried over)', () => {
    for (const text of ['a​b', 'x ', 'clean']) {
      const first = hasInvisibleCharacter(text);
      expect(hasInvisibleCharacter(text)).toBe(first);
      expect(hasInvisibleCharacter(text)).toBe(first);
    }
    expect(hasInvisibleCharacter('a​b')).toBe(true);
    expect(hasInvisibleCharacter('clean')).toBe(false);
    // The /g export keeps its replace-only role and its global flag.
    expect(INVISIBLE_CHARACTER.flags).toContain('g');
  });
});

/** One row of the character table: what each field does with the character. */
interface Row {
  name: string;
  text: string;
  content: 'accept' | 'reject';
  title: 'accept' | 'reject';
}

const TABLE: Row[] = [
  { name: 'emoji with ZWJ sequence', text: '👨‍👩‍👧', content: 'accept', title: 'reject' },
  { name: 'lone surrogate', text: '\uD800', content: 'reject', title: 'reject' },
  { name: 'lone surrogate inside text', text: 'a\uD800b', content: 'reject', title: 'reject' },
  { name: 'NUL', text: 'a\u0000b', content: 'reject', title: 'reject' },
  { name: 'Unicode tag character', text: 'a\u{E0041}b', content: 'reject', title: 'reject' },
  { name: 'bidi override RLO', text: 'a‮b', content: 'reject', title: 'reject' },
  { name: 'bidi isolate LRI', text: 'a⁦b', content: 'reject', title: 'reject' },
  { name: 'BOM', text: '﻿ab', content: 'reject', title: 'reject' },
  { name: 'tab', text: 'a\tb', content: 'accept', title: 'reject' },
  { name: 'carriage return', text: 'a\rb', content: 'accept', title: 'reject' },
  { name: 'newline', text: 'a\nb', content: 'accept', title: 'reject' },
  { name: 'ZWSP U+200B', text: 'a​b', content: 'accept', title: 'reject' },
  { name: 'soft hyphen U+00AD', text: 'a­b', content: 'accept', title: 'reject' },
  { name: 'LRM U+200E', text: 'a‎b', content: 'accept', title: 'reject' },
  { name: 'RLM U+200F', text: 'a‏b', content: 'accept', title: 'reject' },
  { name: 'line separator U+2028', text: 'a b', content: 'accept', title: 'reject' },
  { name: 'paragraph separator U+2029', text: 'a b', content: 'accept', title: 'reject' },
  { name: 'NBSP U+00A0', text: 'a b', content: 'accept', title: 'reject' },
  { name: 'ideographic space U+3000', text: 'a　b', content: 'accept', title: 'reject' },
];

describe('the input character table, per field', () => {
  let temp: TempHome;
  let store: KbStore;
  let agent = 1;
  beforeEach(() => {
    temp = useTempHome();
    store = singleStore(temp.paths);
  });
  afterEach(() => temp.restore());

  for (const row of TABLE) {
    it(`${row.name}: content ${row.content}, title ${row.title}`, async () => {
      expect(typeof checkContent(row.text) === 'object').toBe(row.content === 'accept');
      expect(normalizeTitle(row.text) !== null).toBe(row.title === 'accept');

      const asContent = await store.submitProposal(WS, {
        kind: 'create',
        title: `Row ${row.name}`,
        content: row.text,
        proposer: proposer(agent++),
      });
      expect(asContent.ok).toBe(row.content === 'accept');
      if (!asContent.ok) expect(asContent.code).toBe('invalid');

      const asTitle = await store.submitProposal(WS, {
        kind: 'create',
        title: row.text,
        content: 'body',
        proposer: proposer(agent++),
      });
      expect(asTitle.ok).toBe(row.title === 'accept');
      if (!asTitle.ok) expect(asTitle.code).toBe('invalid');
    });
  }

  it('refuses invalid UTF-8 bytes as content (Buffer input)', () => {
    for (const bytes of [
      Buffer.from([0x61, 0xc3, 0x28]),
      Buffer.from([0xed, 0xa0, 0x80]),
      Buffer.from([0xff]),
    ]) {
      expect(decodeSafeText(bytes)).toBeNull();
      expect(checkContent(bytes)).toBe('invalid');
    }
    expect(checkContent(Buffer.from('ok', 'utf-8'))).toMatchObject({ text: 'ok' });
  });

  it('counts the 64 KiB content cap in UTF-8 bytes, multibyte characters included', async () => {
    const exactly = `${'漢'.repeat(21845)}a`; // 65535 + 1 bytes
    expect(Buffer.byteLength(exactly)).toBe(65536);
    expect(typeof checkContent(exactly)).toBe('object');
    const over = '漢'.repeat(21846); // 65538 bytes, only 21846 code units
    expect(checkContent(over)).toBe('too_large');
    const result = await store.submitProposal(WS, {
      kind: 'create',
      title: 'Big',
      content: over,
      proposer: proposer(),
    });
    expect(result).toMatchObject({ ok: false, code: 'too_large' });
  });

  it('limits titles to 1-120 code points after trimming spaces, stored NFC', () => {
    expect(normalizeTitle('a'.repeat(120))?.title).toBe('a'.repeat(120));
    expect(normalizeTitle('a'.repeat(121))).toBeNull();
    expect(normalizeTitle('😀'.repeat(120))?.title).toBe('😀'.repeat(120));
    expect(normalizeTitle('😀'.repeat(121))).toBeNull();
    expect(normalizeTitle('')).toBeNull();
    expect(normalizeTitle('   ')).toBeNull();
    expect(normalizeTitle('  padded  ')?.title).toBe('padded');
    expect(normalizeTitle('é')?.title).toBe('é');
    expect(normalizeTitle(42)).toBeNull();
  });

  it('treats a fullwidth/case variant as the same title (conflict) but not a homoglyph', async () => {
    const operatorOff = await store.writeSettings(WS, { operatorConfirm: false });
    expect(operatorOff.ok).toBe(true);
    const first = await submitCreate(store, 'Ａ', 'one', proposer(1));
    expect(
      await store.decideProposal(WS, first.id, {
        action: 'approve',
        digest: first.digest,
        actor: proposer(9),
      }),
    ).toMatchObject({ ok: true, state: 'approved' });
    const dup = await store.submitProposal(WS, {
      kind: 'create',
      title: 'a',
      content: 'two',
      proposer: proposer(2),
    });
    expect(dup).toMatchObject({ ok: false, code: 'conflict' });

    // Known limitation, recorded: Cyrillic 'а' (U+0430) is not matched to Latin 'a'.
    const homoglyph = await store.submitProposal(WS, {
      kind: 'create',
      title: 'а',
      content: 'three',
      proposer: proposer(3),
    });
    expect(homoglyph.ok).toBe(true);
  });

  it('answers not_found for a replace or delete of an entry that does not exist', async () => {
    seedEntries(temp.paths, 1, 4);
    const missing = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(
      await store.submitProposal(WS, {
        kind: 'replace',
        targetEntryId: missing,
        content: 'x',
        proposer: proposer(),
      }),
    ).toMatchObject({ ok: false, code: 'not_found' });
    expect(
      await store.submitProposal(WS, {
        kind: 'delete',
        targetEntryId: missing,
        proposer: proposer(),
      }),
    ).toMatchObject({ ok: false, code: 'not_found' });
  });
});
