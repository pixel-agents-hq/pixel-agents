/**
 * Hermes-specific constants. Kept separate from `server/src/constants.ts` so a
 * future single-provider build doesn't accidentally depend on Hermes unless
 * Hermes is the active provider.
 *
 * Hermes Agent (v0.20.0, confirmed via `hermes --help` / `hermes plugins --help` /
 * `hermes hooks --help` against a live install) has three separate hook systems:
 *   - Gateway hooks (~/.hermes/hooks/) -- messaging-platform sessions ONLY
 *     (Telegram/Discord/Slack/WhatsApp/Teams). Do NOT fire for CLI sessions.
 *   - Shell hooks (hooks: block in config.yaml) -- CLI + gateway, but limited to a
 *     small fixed set of directive events (pre_tool_call, subagent_stop,
 *     on_session_finalize, ...) and invoked as external shell scripts.
 *   - Plugin hooks (ctx.register_hook() in ~/.hermes/plugins/<name>/) -- CLI +
 *     gateway, the full documented catalog (pre_tool_call, post_tool_call,
 *     on_session_start, on_session_end, on_session_finalize, subagent_start,
 *     subagent_stop, ...). This is the one that actually covers CLI sessions with
 *     enough granularity to drive character animation, so it's what this provider
 *     installs into.
 *
 * Plugin hooks only fire for sessions started *after* the plugin is loaded
 * (Hermes discovers ~/.hermes/plugins/ once, at process start) -- an
 * already-running `hermes` session cannot retroactively receive them.
 */

/** User-plugin directory (NOT the vendored ~/.hermes/hermes-agent/plugins/ tree --
 *  writing there would mutate Hermes's own git checkout). Matches the documented
 *  "User" plugin tier in plugins.md: "Drop a directory into ~/.hermes/plugins/". */
export const HERMES_PLUGINS_DIRNAME = 'plugins';
export const HERMES_PLUGIN_NAME = 'pixel-agents-bridge';
export const HERMES_PLUGIN_MODULE_FILENAME = '__init__.py';

/** Plugins are opt-in as of Hermes config schema v21+ (plugins.enabled allow-list
 *  in ~/.hermes/config.yaml). `hermes plugins enable <name>` is the documented,
 *  idempotent CLI for this -- used instead of hand-editing YAML. */
export const HERMES_CLI_BIN = 'hermes';

export const HERMES_TERMINAL_NAME_PREFIX = 'hermes';
