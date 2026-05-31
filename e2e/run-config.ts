import path from 'path';

const RAW_RUN_ID = process.env['PIXEL_AGENTS_E2E_RUN_ID']?.trim() ?? '';

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export function getE2ERunId(): string | null {
  if (!RAW_RUN_ID) {
    return null;
  }

  const sanitized = sanitizePathSegment(RAW_RUN_ID);
  return sanitized.length > 0 ? sanitized : null;
}

export function namespaceE2EPath(baseDir: string): string {
  const runId = getE2ERunId();
  return runId ? path.join(baseDir, runId) : baseDir;
}
