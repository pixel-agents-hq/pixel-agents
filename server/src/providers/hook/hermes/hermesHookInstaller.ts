/**
 * Hermes hook installer: manages the `hooks.outbound` entry inside Hermes'
 * own config.yaml (the Hermes analogue of the Claude settings.json installer).
 *
 * Hermes has no hook SCRIPT to run per event: its outbound-webhook subsystem
 * (`agent/outbound_webhooks.py`) reads a list of targets from
 * `<HERMES_HOME>/config.yaml` and POSTs each lifecycle event itself. Installing
 * = adding one target entry. There is nothing to copy to disk and nothing to
 * execute — the entire footprint is a config stanza, which is also what makes
 * uninstall provably complete.
 *
 * The entry carries the server token in the URL query because Hermes' delivery
 * headers are fixed (Content-Type/User-Agent/X-Hermes-*) and it cannot attach
 * `Authorization: Bearer`; the hook route accepts the query credential only
 * from a loopback Host (see server/src/httpServer.ts + wsAuth.ts).
 *
 * Guardrails mirror the Claude installer's contract: abort on an unparseable
 * file, refuse (never replace) user data that is shaped wrong, one-time
 * branded backup, atomic tmp+rename, re-read verify before rename with retry,
 * mode preserved on edit / 0600 on create, every write failure throws.
 *
 * Known fidelity cost, disclosed in consentCopy: writing the config goes
 * through a full YAML parse → stringify round-trip, so COMMENTS in the user's
 * config.yaml do not survive an install/uninstall. This is the same fate any
 * `hermes config set` run imposes (Hermes' own writer is PyYAML round-trip),
 * but it is user-visible, so the disclosure says it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Document, isMap, isSeq, parseDocument, type YAMLMap } from 'yaml';

import {
  HERMES_CONFIG_BACKUP_SUFFIX,
  HERMES_CONFIG_FRESH_FILE_MODE,
  HERMES_CONFIG_MUTATE_ATTEMPTS,
  HERMES_CONFIG_MUTATE_RETRY_DELAY_MS,
  HERMES_CONFIG_TMP_SUFFIX,
  HERMES_HOOK_EVENTS,
  HERMES_HOOK_TIMEOUT_SECONDS,
  HERMES_HOOK_URL_PATH,
  HERMES_OUTBOUND_ENTRY_NAME,
} from './constants.js';

/** One entry of `hooks.outbound` as Hermes parses it (WebhookTarget in
 *  agent/outbound_webhooks.py). Unknown sibling keys are preserved by our
 *  round-trip but must not be invented by us. */
export interface HermesOutboundEntry {
  name?: string;
  url: string;
  events: string[];
  matcher?: string;
  secret_env?: string;
  secret?: string;
  timeout?: number;
  [key: string]: unknown;
}

/** Surfaced when config.yaml exists but cannot be parsed. The operation
 *  (install/uninstall) appends its own outcome suffix — same contract as the
 *  Claude provider's SETTINGS_UNPARSEABLE_MESSAGE. */
export const HERMES_CONFIG_UNPARSEABLE_MESSAGE = "Couldn't parse Hermes config.yaml";

/** Surfaced when config.yaml keeps changing under us across all attempts. */
export const HERMES_CONFIG_CONCURRENT_WRITE_MESSAGE =
  'Hermes config.yaml is being modified by another process';

/** Surfaced when `hooks.outbound` holds something other than a sequence.
 *  Replacing user data we cannot model is the bug class the Claude installer
 *  refuses on; same rule here. */
export const HERMES_OUTBOUND_NOT_ARRAY_MESSAGE =
  'hooks.outbound in Hermes config.yaml is not a list — fix or remove it';

/** Surfaced when `hooks` itself is not a mapping. */
export const HERMES_HOOKS_NOT_OBJECT_MESSAGE =
  'hooks in Hermes config.yaml is not a mapping — fix or remove it';

class ConcurrentWriteError extends Error {
  constructor() {
    super(HERMES_CONFIG_CONCURRENT_WRITE_MESSAGE);
    this.name = 'ConcurrentWriteError';
  }
}

/**
 * Resolve Hermes' data home, mirroring `hermes_constants.py`:
 * `$HERMES_HOME` wins when set; else `%LOCALAPPDATA%\hermes` on Windows
 * (falling back to `~/AppData/Local` when LOCALAPPDATA is blank), else
 * `~/.hermes`. Profile homes (`<home>/profiles/<name>`) are NOT followed:
 * the office installs into the default profile's config, the same one a bare
 * `hermes` invocation reads. (A multiplexed gateway loads each served
 * profile's own config; pointing the office at a secondary profile is a
 * documented manual step: copy the entry into that profile's config.yaml.)
 */
export function getHermesHome(): string {
  const override = process.env['HERMES_HOME'];
  if (override && override.trim()) {
    return expandHome(override.trim());
  }
  if (process.platform === 'win32') {
    const localAppData = (process.env['LOCALAPPDATA'] ?? '').trim();
    const base = localAppData ? localAppData : path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'hermes');
  }
  return path.join(os.homedir(), '.hermes');
}

/** `~` + environment expansion, matching `_expand_hermes_home`'s
 *  expanduser+expandvars behavior closely enough for a config path. */
function expandHome(p: string): string {
  let out = p;
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(os.homedir(), out.slice(1));
  }
  return out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => process.env[name] ?? m);
}

/** Absolute path of the config file the installer manages. */
export function getHermesConfigPath(): string {
  return path.join(getHermesHome(), 'config.yaml');
}

/** Whether a Hermes data home exists at all. Drives `HookProvider.isAvailable`
 *  so the consent gate never asks about Hermes on machines without it. A home
 *  directory without a config.yaml still counts: Hermes creates the file
 *  lazily, and refusing to offer install before the user has written any
 *  setting would be needlessly strict. */
export function hermesHomeExists(): boolean {
  try {
    return fs.statSync(getHermesHome()).isDirectory();
  } catch {
    return false;
  }
}

/** URL of our outbound target for a given server base + token. The token rides
 *  the query (bearer-capable-but-header-less delivery); `encodeURIComponent`
 *  because tokens are opaque strings. */
export function buildHermesHookUrl(serverUrl: string, authToken: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}${HERMES_HOOK_URL_PATH}?token=${encodeURIComponent(authToken)}`;
}

/** Wire identity of our entry: url contains the path segment we own. Name is
 *  checked too, but url is the authority — a renamed entry pointing at us is
 *  still ours to replace, and one pointing elsewhere is not ours to touch. */
function isOurEntry(entry: Record<string, unknown>): boolean {
  const url = typeof entry.url === 'string' ? entry.url : '';
  return url.includes(`${HERMES_HOOK_URL_PATH}?`) || url.endsWith(HERMES_HOOK_URL_PATH);
}

/** The entry we write. `events` is interpolated from HERMES_HOOK_EVENTS so a
 *  future event added to the list cannot ship without being installed (and
 *  vice versa — uninstalling sweeps stale ones, see mergeOutbound). */
function makeHermesEntry(serverUrl: string, authToken: string): HermesOutboundEntry {
  return {
    name: HERMES_OUTBOUND_ENTRY_NAME,
    url: buildHermesHookUrl(serverUrl, authToken),
    events: [...HERMES_HOOK_EVENTS],
    timeout: HERMES_HOOK_TIMEOUT_SECONDS,
  };
}

/**
 * Merge our entry into the user's outbound list: our existing entries are
 * REPLACED by the canonical one (first position kept, so a long list reads
 * stably), foreign entries are preserved verbatim in order, an entry pointing
 * at a dead port just gets rewritten (url+token change every server start —
 * the standalone picks a fresh port; idempotent install re-points in place).
 */
function mergeOutbound(
  existing: HermesOutboundEntry[],
  entry: HermesOutboundEntry,
): HermesOutboundEntry[] {
  const out: HermesOutboundEntry[] = [];
  let placed = false;
  for (const item of existing) {
    if (isOurEntry(item)) {
      if (!placed) {
        out.push(entry);
        placed = true;
      }
      // Duplicate ours (a user copy-paste) collapses into the one canonical entry.
      continue;
    }
    out.push(item);
  }
  if (!placed) out.push(entry);
  return out;
}

/** Read + parse the config document. Returns null when the file does not
 *  exist (a fresh create). Throws on parse failure — fail-closed like the
 *  Claude installer: we never rewrite a file we cannot fully model. */
function readDocument(): { text: string; doc: Document } | null {
  const file = getHermesConfigPath();
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new Error(`${HERMES_CONFIG_UNPARSEABLE_MESSAGE}: ${doc.errors[0].message}`);
  }
  return { text, doc };
}

/** Extract the current `hooks.outbound` list as JS objects, refusing the
 *  shapes we cannot safely rewrite (non-map hooks, non-seq outbound,
 *  non-mapping entries). Returns [] when the path is absent. */
function readOutboundEntries(doc: Document): HermesOutboundEntry[] {
  const hooks = doc.getIn(['hooks']);
  if (hooks === undefined) return [];
  if (!isMap(hooks)) throw new Error(HERMES_HOOKS_NOT_OBJECT_MESSAGE);
  const outbound = (hooks as YAMLMap).get('outbound');
  if (outbound === undefined || outbound === null) return [];
  if (!isSeq(outbound)) throw new Error(HERMES_OUTBOUND_NOT_ARRAY_MESSAGE);
  const items = outbound.toJSON() as unknown[];
  return items.map((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(
        `hooks.outbound[${i}] in Hermes config.yaml is not a mapping — fix or remove it`,
      );
    }
    return item as HermesOutboundEntry;
  });
}

/** Render the document with `hooks.outbound` replaced by `entries` (or the
 *  key pruned away when empty — including `hooks` itself if it then holds
 *  nothing; we leave no empty scaffolding behind, but only ever prune the
 *  container WE emptied, never a user's other keys — those live in this same
 *  map and are preserved). */
function serializeWithOutbound(doc: Document, entries: HermesOutboundEntry[]): string {
  if (entries.length === 0) {
    // Guarded deletes: yaml's deleteIn THROWS when an ancestor is absent
    // ("Expected YAML collection at hooks") — a config that never had the
    // path is exactly the uninstall-nothing case, and must stay untouched.
    const hooks = doc.getIn(['hooks']);
    if (isMap(hooks)) {
      (hooks as YAMLMap).delete('outbound');
      if ((hooks as YAMLMap).items.length === 0) doc.deleteIn(['hooks']);
    }
  } else {
    doc.setIn(['hooks', 'outbound'], entries);
  }
  return doc.toString({ lineWidth: 0 });
}

/** One-time branded backup: skip ONLY when config.yaml never existed (nothing
 *  to preserve). Unlike Claude's config, which we may have created wholesale,
 *  a Hermes config.yaml is overwhelmingly the user's own file — and our write
 *  reformats comments, so the original is always worth keeping. */
function ensureBackup(): void {
  const file = getHermesConfigPath();
  const backup = file + HERMES_CONFIG_BACKUP_SUFFIX;
  if (fs.existsSync(backup)) return;
  if (!fs.existsSync(file)) return; // fresh create: nothing pre-existing to save
  fs.copyFileSync(file, backup);
  // Preserve the original's mode on the backup too — it can hold API keys.
  try {
    fs.chmodSync(backup, fs.statSync(file).mode & 0o777);
  } catch {
    /* Windows: chmod is a best-effort no-op there, never fail the install */
  }
}

/**
 * Read-modify-write cycle with concurrent-writer protection: the document is
 * parsed from the file bytes, the mutate step produces new bytes, and
 * immediately before the atomic rename the file is re-read and byte-compared —
 * a drift throws ConcurrentWriteError and burns one retry attempt. The first
 * successful write also gets the branded backup BEFORE any bytes change.
 */
async function mutateConfig(mutate: (doc: Document) => string): Promise<void> {
  const file = getHermesConfigPath();
  for (let attempt = 1; attempt <= HERMES_CONFIG_MUTATE_ATTEMPTS; attempt++) {
    const current = readDocument();
    const textBefore = current?.text ?? null;
    const doc = current?.doc ?? new Document({});
    const next = mutate(doc);

    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    if (textBefore !== null) ensureBackup();

    // Verify immediately before committing: the file must still be the bytes
    // we parsed (or still be absent, for the create path).
    const reread = readDocument();
    const rereadText = reread?.text ?? null;
    if (rereadText !== textBefore) {
      if (attempt === HERMES_CONFIG_MUTATE_ATTEMPTS) throw new ConcurrentWriteError();
      await new Promise((r) => setTimeout(r, HERMES_CONFIG_MUTATE_RETRY_DELAY_MS));
      continue;
    }

    const tmp = file + HERMES_CONFIG_TMP_SUFFIX;
    const existed = textBefore !== null;
    fs.writeFileSync(tmp, next, {
      mode: existed ? undefined : HERMES_CONFIG_FRESH_FILE_MODE,
      flag: 'w',
    });
    if (existed) {
      try {
        fs.chmodSync(tmp, fs.statSync(file).mode & 0o777);
      } catch {
        /* best-effort mode preservation; rename proceeds either way */
      }
    }
    fs.renameSync(tmp, file);
    return;
  }
}

/** Install (or re-point) our outbound target. Called at consent grant, at
 *  every standalone boot after a durable grant (port/token rotate), and on an
 *  explicit UI toggle — the toggle IS consent (cli.ts), same contract as
 *  Claude. */
export async function installHooks(serverUrl: string, authToken: string): Promise<void> {
  const entry = makeHermesEntry(serverUrl, authToken);
  await mutateConfig((doc) =>
    serializeWithOutbound(doc, mergeOutbound(readOutboundEntries(doc), entry)),
  );
}

/** Remove every entry identified as ours. Foreign entries are untouched; the
 *  config file itself is never deleted. */
export async function uninstallHooks(): Promise<void> {
  await mutateConfig((doc) => {
    const existing = readOutboundEntries(doc);
    const kept = existing.filter((e) => !isOurEntry(e));
    // Nothing ours to remove: keep the round-tripped bytes as-is.
    if (kept.length === existing.length) return serializeWithOutbound(doc, existing);
    return serializeWithOutbound(doc, kept);
  });
}

/** True when any outbound entry points at our hook path. Throws on an
 *  unparseable file — callers degrade to installed=false (the consent loop's
 *  established contract) and the toggle surfaces the message. */
export function areHooksInstalled(): boolean {
  const current = readDocument();
  if (!current) return false;
  let entries: HermesOutboundEntry[];
  try {
    entries = readOutboundEntries(current.doc);
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message === HERMES_OUTBOUND_NOT_ARRAY_MESSAGE ||
        err.message === HERMES_HOOKS_NOT_OBJECT_MESSAGE)
    ) {
      // Malformed but NOT ours to claim: report not-installed rather than
      // throwing the consent loop into its catch-all (same visible outcome,
      // clearer semantics for the toggle path which reads the message).
      return false;
    }
    throw err;
  }
  return entries.some((e) => isOurEntry(e));
}
