/** Sending files to a terminal: the upload's address and what gets pasted. */
import { expect, test } from 'vitest';

import {
  dragCarriesFiles,
  isLoopbackHostname,
  pasteCarriesFiles,
  pathsToPaste,
  terminalFileLocateUrl,
  terminalFileUrl,
  uploadFailureReason,
} from '../src/terminal/fileUpload.js';

test('the upload carries the file name and the token, both encoded', () => {
  expect(terminalFileUrl(7, 'my photo&1.jpg', 'tok/en')).toBe(
    '/api/terminal/7/files?name=my+photo%261.jpg&token=tok%2Fen',
  );
});

test('paths are pasted with a space between them and one after', () => {
  expect(pathsToPaste(['/a/one.png', '/a/two.png'])).toBe('/a/one.png /a/two.png ');
  expect(pathsToPaste(['/a/one.png'])).toBe('/a/one.png ');
});

test('nothing is pasted when no file arrived', () => {
  expect(pathsToPaste([])).toBe('');
});

test('a refusal is explained in words', () => {
  expect(uploadFailureReason(413)).toBe('too large');
  expect(uploadFailureReason(404)).toBe('this terminal is gone');
  expect(uploadFailureReason(401)).toBe('not allowed from this page');
  expect(uploadFailureReason(500)).toBe('the server could not save it');
});

test('only a loopback page shares a disk with the server', () => {
  expect(isLoopbackHostname('localhost')).toBe(true);
  expect(isLoopbackHostname('127.0.0.1')).toBe(true);
  expect(isLoopbackHostname('[::1]')).toBe(true);
  expect(isLoopbackHostname('mac-mini.example.ts.net')).toBe(false);
});

test("the lookup is asked under the terminal's files route", () => {
  expect(terminalFileLocateUrl(7, 'tok')).toBe('/api/terminal/7/files/locate?token=tok');
});

test('a file drag is told from a text drag, in every browser', () => {
  expect(dragCarriesFiles(['Files'])).toBe(true);
  // Firefox lists its own type first.
  expect(dragCarriesFiles(['application/x-moz-file', 'Files'])).toBe(true);
  expect(dragCarriesFiles(['application/x-moz-file'])).toBe(true);
  expect(dragCarriesFiles(['text/plain', 'text/html'])).toBe(false);
  expect(dragCarriesFiles([])).toBe(false);
  // A drop that holds files counts whatever its types say.
  expect(dragCarriesFiles(['text/uri-list'], 1)).toBe(true);
});

test("a paste is one of files unless the clipboard holds a document's text beside them", () => {
  // A screenshot; files copied in Explorer.
  expect(pasteCarriesFiles(['Files'], 1)).toBe(true);
  // A file copied in Finder also carries its name as text.
  expect(pasteCarriesFiles(['text/plain', 'Files'], 1)).toBe(true);
  // An image copied off a web page carries its markup.
  expect(pasteCarriesFiles(['text/html', 'Files'], 1)).toBe(true);
  // Cells copied from a spreadsheet: text, markup and a picture of them.
  expect(pasteCarriesFiles(['text/plain', 'text/html', 'Files'], 1)).toBe(false);
  // Plain text, and a type list that names files where none came.
  expect(pasteCarriesFiles(['text/plain'], 0)).toBe(false);
  expect(pasteCarriesFiles(['Files'], 0)).toBe(false);
});
