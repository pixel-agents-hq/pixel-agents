/**
 * Constants for the "Needs you" inbox: Open-in-Claude links and the
 * usage-limit tracker (docs/office/DESIGN.md, phase G). Kept beside the module
 * rather than in server/src/constants.ts so the feature stays self-contained.
 */

/** Where a Remote Control session opens on the web: this + `session_<id>`. */
export const CLAUDE_CODE_WEB_URL_PREFIX = 'https://claude.ai/code/';

/** Transcript record Claude Code writes while Remote Control is on. */
export const BRIDGE_SESSION_RECORD_TYPE = 'bridge-session';
/** The bridge id's prefix in the transcript (`cse_012Dp…`) ... */
export const BRIDGE_SESSION_ID_PREFIX = 'cse_';
/** ... and the web URL's spelling of the same id (`session_012Dp…`). */
export const WEB_SESSION_ID_PREFIX = 'session_';
/** A bridge id is the prefix plus a short alphanumeric token. Anything else
 *  is not turned into a link. */
export const BRIDGE_SESSION_ID_PATTERN = /^cse_[A-Za-z0-9]{1,128}$/;

/** Seeding reads the transcript's tail (and, when that has no bridge record,
 *  its head) -- never the whole file, which can run to many megabytes. Claude
 *  Code repeats the bridge record every few dozen lines, so the tail has one. */
export const INBOX_SEED_TAIL_BYTES = 256 * 1024;
export const INBOX_SEED_HEAD_BYTES = 64 * 1024;

/** A paused agent whose reset time is unknown is un-paused after this long
 *  (the session window is five hours) unless activity clears it first. */
export const USAGE_LIMIT_FALLBACK_PAUSE_MS = 5 * 60 * 60 * 1000;
/** Reset times further out than this are treated as unparsed (a weekly limit
 *  is the longest there is). */
export const USAGE_LIMIT_MAX_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

/** The model name Claude Code writes on synthetic records (API errors,
 *  interrupts): never a real response. */
export const SYNTHETIC_MODEL = '<synthetic>';
