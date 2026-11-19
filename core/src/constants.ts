/**
 * Shared constants used across server, extension, and webview.
 * Only constants needed by core interfaces live here.
 * Server-specific timing constants stay in server/src/constants.ts.
 * Webview-specific rendering constants stay in webview-ui/src/constants.ts.
 * Provider-specific constants stay in their provider directory.
 */

// ── Hook API ─────────────────────────────────────────────────

export const HOOK_API_PREFIX = '/api/hooks';
/** Path prefix for a provider's account usage reports (`/api/usage/:providerId`),
 *  sent by the status line bridge. Bearer-authenticated like the hook route. */
export const USAGE_API_PREFIX = '/api/usage';
export const SERVER_JSON_DIR = '.pixel-agents';
export const SERVER_JSON_NAME = 'server.json';
export const HOOK_SCRIPTS_DIR = '.pixel-agents/hooks';

// ── Community ────────────────────────────────────────────────

/** The project's Discord invite (the Intro, the changelog, the tutorial's Guide). */
export const DISCORD_INVITE_URL = 'https://discord.gg/Yk7jXebv9H';

// ── Display ──────────────────────────────────────────────────

export const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
export const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;

// ── Characters ───────────────────────────────────────────────

/** A repeated character's clothes colours, in order (characters/repeatClothes.ts):
 *  the nth repeat wears the nth, as a hue in degrees — red, blue, green, yellow,
 *  purple, cyan, pink, then orange, lime, indigo, teal, magenta; past the end it cycles. */
export const REPEAT_CLOTHES_HUES = [0, 220, 120, 55, 275, 185, 320, 28, 90, 245, 160, 340] as const;
/** Saturation (0-100) a repeat's clothes are colorized at, keeping each piece's shading. */
export const REPEAT_CLOTHES_SATURATION = 70;

// ── Terminal (standalone embedded terminal) ──────────────────
// The raw PTY byte stream deliberately lives OUTSIDE the AsyncAPI contract --
// it is a data plane (unstructured, high-frequency), not a control plane.
// Only the terminal's control-plane facts (availability, session open/close)
// are AsyncAPI ServerMessages. See docs/design/standalone-terminal.md.

/** Path prefix for the per-agent terminal WebSocket: `/terminal/:agentId`. The
 *  handshake carries the server token as `?token=`, exactly like `/ws` (see
 *  server/src/wsAuth.ts); the frame shapes are in terminalFrames.ts. */
export const TERMINAL_WS_PREFIX = '/terminal';
/** HTTP prefix of a terminal's file upload: `POST <prefix>/:agentId/files?name=`
 *  with the file as the raw body, gated like the terminal socket (the same
 *  `?token=`). The file is saved on the server's machine and its path comes
 *  back, for the office to paste into the terminal. */
export const TERMINAL_FILES_API_PREFIX = '/api/terminal';
/** Under a terminal's `files` route: asked first by a browser on the server's
 *  own machine, `POST …/files/locate` with `{ name, size, lastModified }`
 *  answers the path of that very file when the server finds it on its disk
 *  (404 otherwise), so no copy is made of a file that is already there. */
export const TERMINAL_FILES_LOCATE_SUFFIX = '/locate';
/** The largest file a terminal upload accepts. The office checks it before
 *  sending: a server refusing mid-upload reads as a network error in a browser. */
export const TERMINAL_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

// ── PC shells ────────────────────────────────────────────────
// A PC shell (CONTEXT.md → Interactive Furniture) is a terminal the office owns
// that is not an agent. Its ids are its own, from here up: apart from every
// agent id (counting from 1) and the Sub-agent watch's shadow ids (from
// 1 000 000), so one number names one terminal socket and one card, and a PC
// shell's id is never mistaken for an agent's (core/src/pcShells.ts).

/** The first PC shell id is one above this. */
export const PC_SHELL_ID_BASE = 1_000_000_000;
/** A PC shell's name when it started in the home folder (no Directory): its card's name. */
export const PC_SHELL_HOME_NAME = 'Home';

// ── Transport ────────────────────────────────────────────────
// Connection-state names for the MessageTransport state machine.

export const TRANSPORT_STATE_CONNECTING = 'connecting';
export const TRANSPORT_STATE_CONNECTED = 'connected';
export const TRANSPORT_STATE_RECONNECTING = 'reconnecting';
export const TRANSPORT_STATE_DISCONNECTED = 'disconnected';
