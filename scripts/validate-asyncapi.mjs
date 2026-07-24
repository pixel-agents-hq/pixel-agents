/**
 * Validate core/asyncapi.yaml.
 *
 * Replaces `asyncapi validate` from @asyncapi/cli. The CLI pulled in ~25 advisories
 * (next, npm/tar, @oclif/*, @stoplight/*) for this one check, while @asyncapi/parser
 * -- the thing the CLI itself validates with -- is already present via @asyncapi/modelina.
 *
 * Exits 1 on any spec error so CI fails the same way the CLI did.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Parser } from '@asyncapi/parser';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const SPEC_PATH = path.join(REPO_ROOT, 'core', 'asyncapi.yaml');

// Spectral severities: 0 = error, 1 = warn, 2 = info, 3 = hint.
const SEVERITY_ERROR = 0;
const SEVERITY_LABELS = ['error', 'warning', 'info', 'hint'];

function format(diagnostic) {
  const label = SEVERITY_LABELS[diagnostic.severity] ?? 'unknown';
  const line = diagnostic.range?.start?.line;
  const at = line === undefined ? '' : `:${line + 1}`;
  return `  ${label}${at} ${diagnostic.message}`;
}

async function main() {
  if (!fs.existsSync(SPEC_PATH)) {
    console.error(`[validate-asyncapi] ${SPEC_PATH} not found.`);
    process.exit(1);
  }

  const { document, diagnostics } = await new Parser().parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  const errors = diagnostics.filter((d) => d.severity === SEVERITY_ERROR);

  for (const diagnostic of diagnostics) {
    console.log(format(diagnostic));
  }

  // A parser that returns no document produced no usable spec, even without an
  // error-severity diagnostic. Treat that as a failure rather than a silent pass.
  if (errors.length > 0 || !document) {
    console.error(`[validate-asyncapi] core/asyncapi.yaml is invalid (${errors.length} error(s)).`);
    process.exit(1);
  }

  console.log('[validate-asyncapi] core/asyncapi.yaml is valid.');
}

main().catch((error) => {
  console.error('[validate-asyncapi]', error);
  process.exit(1);
});
