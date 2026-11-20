/**
 * Tests and e2e may delete folders only through their guard (server/__tests__/helpers/removeTempDir.ts,
 * e2e/helpers/removeTempDir.ts, webview-ui/test/helpers/removeTempDir.ts): a test that removed a
 * computed path once deleted the contents of the user's whole temp directory. Every recursive
 * `rm` / `rmSync` / `rmdirSync` anywhere else is an error.
 */
const message =
  'Delete folders in tests only through the helpers/removeTempDir guard (removeTempDir, removeInTempDir, clearTestHome, removeUnder): a recursive rm of a computed path once emptied the temp directory.';
const CALLS = '/^(rm|rmSync|rmdirSync)$/';

export const noComputedRecursiveDelete = [
  'error',
  {
    selector: `CallExpression[callee.property.name=${CALLS}] > ObjectExpression > Property[key.name='recursive']`,
    message,
  },
  {
    selector: `CallExpression[callee.name=${CALLS}] > ObjectExpression > Property[key.name='recursive']`,
    message,
  },
];
