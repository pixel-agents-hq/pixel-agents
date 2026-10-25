# OpenClaw provider and Gateway relay

This experimental integration extends [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents), retaining its MIT license, office editor, assets, adapters, and Claude Code integration. It is an **observer**, not a remote-control interface for OpenClaw. It does not launch agents, send messages to them, approve their tools, change models, or attach to their terminals.

The fork adds:

- A bundled `pixel-agents-openclaw` Gateway plugin that observes typed lifecycle metadata.
- A Pixel Agents hook provider for the existing shared runtime and browser/VS Code office UI.
- One character per configured OpenClaw agent per Gateway, aggregating ordinary chats into a single winning activity.
- Native agent names and manual overrides, with no Discord, Teams, or other messaging dependency.
- Local same-user discovery and optional authenticated delivery to one remote office.
- Generation/working, tool, reading/research, and idle activity; delegated child-session lifecycle handling while preserving the original spawn-tool character path.
- A separate hook credential, so the Gateway does not need the office's administrative token.

## Build this branch, not the upstream npm release

The upstream Marketplace and npm packages may not contain this experimental integration. This guide is also copied to `dist/openclaw-plugin/README.md` and checked as part of the package contract, so it accompanies the installable relay. Build the fork explicitly:

```bash
git clone --branch feat/openclaw-provider https://github.com/thespillmonkey/pixel-agents.git
cd pixel-agents
npm ci
npm run package
node dist/cli.js --host 127.0.0.1 --port 3100
```

Use the private URL printed by the CLI to manage the office. Keep its `?token=` private: it authorizes administrative UI actions. A bare URL opens a read-only office. For the extension, open this checkout in VS Code and launch the Extension Development Host with F5; installing the upstream extension is not equivalent to loading this branch.

Pixel Agents requires Node.js 20+; OpenClaw has its own runtime requirements. The relay was exercised against OpenClaw **2026.10.3**. That is a tested version, not a guarantee that older or future SDKs expose compatible hooks and SecretRef APIs. Use a compatible release and inspect its plugin load status; do not bypass Gateway capability or conversation-access restrictions to make it load.

## Local setup

1. Start this fork's office as the same OS user as OpenClaw.
2. Accept the OpenClaw-specific connection disclosure. It is offered only when a local OpenClaw configuration exists (`OPENCLAW_CONFIG_PATH`, or `openclaw.json` under `OPENCLAW_STATE_DIR`/`~/.openclaw`), so an unconfigured Claude-only office gains no OpenClaw install prompt. Remote ingress remains registered regardless. The installer copies the bundled plugin to `~/.pixel-agents/openclaw-plugin/`, then invokes OpenClaw's normal linked-plugin installation with capability acceptance. This modifies the selected OpenClaw profile's plugin installation/configuration; it does not change agent models or channel routes.
3. If required, restart the Gateway at a safe point when existing jobs can tolerate interruption. This is an operator action, not an automatic background restart by the relay.
4. Check `openclaw plugins list --json` for `pixel-agents-openclaw` being enabled and loaded. A copied directory alone is not proof of an active plugin.
5. Use the agent in a tracked workspace. Enable **Settings → Watch All Sessions** when workspace paths are outside the office's tracked directories, especially with remote Gateways. Enable **Always Show Labels** to see activity without selecting each character.

Characters appear on observed activity, not from an inventory of every configured agent. There is no synthetic population of inactive agents at startup. OpenClaw characters are headless: there is no OpenClaw terminal to open from the office.

Local discovery reads live-process registrations under `~/.pixel-agents/servers/` with a legacy `server.json` fallback and sends authenticated loopback requests to all discovered offices. Separate VS Code and standalone runtimes keep their own character state while sharing the existing office assets/layout conventions.

## Agent identity, session aggregation, and names

An **OpenClaw configured agent**, an **OpenClaw chat session**, and a **Pixel Agents character** are different concepts. This provider deliberately maps multiple ordinary chat sessions for the same configured agent to one character:

```text
Gateway A / agent "main"
  chat session 1: generating ─┐
  chat session 2: exec tool  ─┼─ one character "Avery": Working
  chat session 3: idle       ─┘

Gateway A / agent "builder" ─── separate character "Blake"
Gateway B / agent "main"    ─── separate character, even with the same agent ID
```

The Gateway keeps individual session state in memory and sends only the collapsed character projection. The office does **not** get a list of private chat keys, chat titles, participants, message content, or a session-inspection UI. "Session information" here means lifecycle/tool metadata used for arbitration, not a chat history viewer.

The agent ID comes from hook context, with a fallback to the `agent:<id>:...` session-key prefix. Agent configuration supports `agents.entries` and `agents.list`. If neither identity source is available, the relay falls back to a hashed session identity; it cannot safely merge unknown agents.

Names resolve in this order:

1. `plugins.entries.pixel-agents-openclaw.config.agentNames[agentId]`.
2. The configured agent's `identity.name`.
3. Its configured `name`.
4. Its agent ID.

Names are not inferred from workspace basenames, Discord bot accounts, channel configuration, or conversation text. Incoming display names are stripped of control characters and capped at 120 characters. Overrides are Gateway plugin configuration, **not** a new Pixel Agents name-editing settings panel.

Ordinary characters are keyed by a hash of Gateway namespace plus agent ID. The default namespace uses hostname, OpenClaw state/home location, and config-path environment metadata. Set a distinct stable `gatewayId` when multiple Gateways share those locations or when an identity must survive a host migration. Reusing a namespace and agent ID across Gateways intentionally creates a collision; display names do not define identity.

## Which activity wins?

The relay chooses one visible mode across all ordinary sessions belonging to the character:

| Priority    | Session activity                       | Visible result                                                         |
| ----------- | -------------------------------------- | ---------------------------------------------------------------------- |
| 1 — highest | Model generation, including thinking   | **Working**; active/typing behavior, without forwarding reasoning text |
| 2           | A non-reading tool is active           | Tool-specific activity label and active animation                      |
| 3           | Only reading/research tools are active | Reading/research activity label and supported reading animation        |
| 4           | No generation or active tools          | **Idle**                                                               |

The most recently updated session wins ties. Within the winning tool session, a non-reading tool is preferred over a reading tool. If no non-reading tool exists, its latest reading tool is selected. One finished or idle chat cannot overwrite another chat's higher-priority work. Closing one chat removes only that chat's contribution; the character closes when its last tracked session ends, not simply because it becomes idle.

Tool names, not tool arguments/results, drive labels: `exec`/`exec_command` → "Running a command", `apply_patch` → "Editing files", `web_fetch`/`web__run` → "Researching the web", `browser` → "Using the browser", memory tools → "Checking memory", and spawn tools → "Starting a sub-agent". Unknown tools retain a generic "Using <tool-name>" label. The priority classifier recognizes read/search/fetch/browse-style names; the visual reading-tool set is provider-defined, so an unfamiliar custom tool can have reading priority without a specialized reading animation.

Hooks drive the projection:

| OpenClaw hook                                | Relay behavior                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `model_call_started`                         | Announce/re-adopt the character and mark its source session working                                              |
| `model_call_ended`                           | Schedule a 250 ms idle fallback; a new model/tool call cancels it, and active tools prevent it from forcing idle |
| `before_tool_call`                           | Correlate the session and hashed call ID, then mark the tool active                                              |
| `after_tool_call`                            | Finish that correlated tool; resume working between calls                                                        |
| `session_end`                                | Remove that session's contribution                                                                               |
| `subagent_ended` / ended `subagent_progress` | Close the identified delegated child session                                                                     |
| `gateway_stop`                               | Attempt to close this relay's characters and clear timers                                                        |

The model-end timer is a metadata-only completion fallback, not a guaranteed full-turn completion signal. A long gap between model calls can briefly look idle; a missing completion hook can leave a character active. Delivery order is serialized per character to prevent older HTTP completions from overwriting newer projections.

## Child sessions and original spawn-tool characters

Ordinary chats merge; genuine delegated work is the exception. Session keys marked `:subagent:` or `:acp:` receive a separate identity and a name such as **Avery · subtask**. Their ordinary generation/tool activity is visible, and native child-completion metadata removes the child without removing the parent's other sessions. This separate child-session character is not a full OpenClaw team/parent topology UI.

Relay v1.2.0 also includes an explicit `is_subagent` boolean in its collapsed session announcement. The office gives **only** characters marked as children a **120-second inactivity lease**, renewed by their own lifecycle/tool events. Parent activity cannot renew a child's lease. Native completion still removes a child immediately; the timeout is a fallback when that signal is missed, a child crashes, or delivery stops. A normal agent whose friendly name happens to end in `· subtask` is not a child, and neither normal nor unmarked legacy characters expire on inactivity. Upgrade both relay and office for this rule; the office deliberately does not guess child identity from names.

The lease measures silence in observed activity, not whether a task actually stopped. A child doing more than two minutes of uninterrupted model generation or one silent long-running tool can disappear from the office and reappear on its next delivered activity. Expiry never cancels, kills, archives, or changes the underlying OpenClaw session. Normal configured-agent characters remain indefinitely while idle.

The original UI path that creates a temporary nearby **Subtask:** character for a spawn tool is **not disabled**. `sessions_spawn` and `spawn_agent` remain declared spawn tools, and the tool-based character follows that tool's completion. Returning from an asynchronous spawn is not the same as completing its child session: the separately identified native child can continue until its own completion metadata arrives. These two representations can overlap; they are not deduplicated into a parent/child graph in this version.

Claude Code's original sub-agent and teammate behavior remains enabled. Shared UI changes are limited to choosing a live unfinished tool label, showing **Working** while active without one, and preventing an old waiting label from hiding renewed activity. This is not a redesign of the office or a replacement of the Claude provider.

## Remote office setup

The relay runs **on the Gateway host**, while the office runs elsewhere. A browser connects to the office; it does not connect directly to the OpenClaw Gateway.

```text
OpenClaw Gateway → metadata-only relay → HTTPS or SSH tunnel
                                           ↓
                                Pixel Agents hook endpoint
                                           ↓
                                 browser / VS Code office
```

1. Run this fork's office on a stable port. Keep the process bound to loopback when using an SSH tunnel or local TLS reverse proxy. If exposing the UI through a proxy, configure the existing `--allowed-host` option for its public hostname; do not expose an administrative token over plaintext LAN HTTP.
2. Install the **built** `dist/openclaw-plugin/` directory on the Gateway host, for example by securely copying it to a persistent plugin directory there and running:

   ```bash
   openclaw plugins install --link --force --accept-capabilities /absolute/path/to/openclaw-plugin
   ```

   Run this for the intended OpenClaw profile/user. Installing from the office's local settings does not install software on a different host. Do not link a temporary build directory that will disappear.

3. Pixel Agents creates `~/.pixel-agents/relay-token` with owner-only permissions (`0600`). Securely transfer that **hook-only** credential into a supported OpenClaw secret provider on the Gateway. Do not substitute the administrative URL token or commit either secret to the repo.
4. Configure the plugin entry below, using an existing secret provider and replacing the example hostname. Restart/reload the Gateway as required by that OpenClaw version, at a coordinated safe point.
5. Enable **Watch All Sessions** in the office if the Gateway workspace paths differ from its tracked local directories. Then trigger normal agent activity.

```json
{
  "plugins": {
    "entries": {
      "pixel-agents-openclaw": {
        "enabled": true,
        "config": {
          "gatewayId": "development-gateway",
          "agentNames": { "main": "Avery", "builder": "Blake" },
          "localDiscovery": false,
          "remote": {
            "endpoint": "https://office.example/api/hooks/openclaw",
            "token": {
              "source": "store",
              "provider": "default",
              "id": "PIXEL_AGENTS_RELAY_TOKEN"
            }
          }
        }
      }
    }
  }
}
```

The secret provider must exist in your OpenClaw configuration; the example is not a provider-creation command. The plugin uses OpenClaw's prepared secret snapshot inside active hooks, with configured resolution as a fallback. An unavailable startup secret does not remain cached as unavailable, and subsequent events can see credential rotation.

For an SSH tunnel initiated **from the Gateway host** to the office host:

```bash
ssh -N -L 13100:127.0.0.1:3100 office-user@office-host
```

Use `http://127.0.0.1:13100/api/hooks/openclaw` as the plugin endpoint while that tunnel is alive. A separate browser-side tunnel may be needed to open the office from your workstation. Verify SSH host fingerprints through a trusted channel; never disable host-key checking to make a tunnel work.

### Configuration reference

All fields below belong under `plugins.entries.pixel-agents-openclaw.config`:

| Field             | Default / meaning                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `localDiscovery`  | `true`; deliver to locally registered live offices as well as any configured remote target            |
| `gatewayId`       | Optional stable unique namespace; otherwise derived from host/state/config location                   |
| `agentNames`      | Optional map of agent IDs to non-empty friendly names, maximum 120 characters                         |
| `remote.endpoint` | Optional final `/api/hooks/openclaw` URL; HTTPS required except literal loopback or `localhost` HTTP  |
| `remote.token`    | Required with a remote endpoint; OpenClaw SecretRef recommended, non-empty literal accepted by schema |

Endpoints containing URL user/password credentials, query strings, fragments, or another path are rejected. Redirects are refused. Do not rely on token-bearing query strings. Local discovery uses the office's existing local credential; the separately configured remote path uses the hook-only credential.

## Privacy and authentication boundaries

"Metadata-only" means the relay forwards a fixed operational projection, not conversations. It sends opaque hashed character/tool IDs, configured display names, tool names, lifecycle event types/reasons, and workspace directory paths. It does **not** forward prompts, reasoning text, replies, chat messages, tool parameters/results, transcripts, channel IDs, or source session keys. Authorization credentials are used only in the HTTP authentication header, not included in lifecycle payloads.

Display names and directory paths can still reveal personal/project information. Stable hashes provide correlation, not anonymity or encryption, and small guessed input spaces can be inferred. Use trusted viewers, transport security, and suitable generic name overrides. Like other installed Gateway plugins, this code executes in the Gateway process: content filtering is implemented by the relay, not a claim of operating-system sandbox isolation.

The plugin deliberately avoids conversation-bearing `agent_end`/message hooks and has no transcript fallback. It does not require a global conversation-access exception. Existing Gateway guards remain in force.

The remote relay token authenticates hook ingress; on the office WebSocket it is read-only, not an administrative capability. It cannot launch agents, install hooks, attach terminals, or edit office settings. Hook access can still inject fake activity and observe a readable office, so protect it. The office retains its existing bare-URL read-only viewing model; this integration does not make office contents confidential to every reachable viewer. Restrict network reachability when that matters.

## Delivery, recovery, and current limits

- Each HTTP request times out after two seconds. Hooks await delivery, and one projection can involve several serialized requests; therefore slow or unavailable offices **can add latency**. Delivery errors are swallowed rather than failing the agent's task. This is not a non-blocking transport guarantee.
- Delivery is best-effort: no durable event queue, acknowledgment handling, delivery retry, replay log, inventory poll, or idle heartbeat. Later activity reannounces a character, allowing recovery after office restart; an idle character is not automatically replayed until a later event.
- Normal-agent idleness is never a reason to despawn. Explicitly marked OpenClaw child sessions expire after two minutes without their own events; normal and unmarked legacy characters have no inactivity expiry. Missing end events can still leave stale normal/legacy characters. Shutdown delivery may be unavailable after the Gateway has retired its hook runtime.
- Session aggregation is in-memory and resets when the Gateway/plugin restarts. It does not reconstruct every old chat from disk or join state across multiple Gateway processes. Reusing a name does not merge agents.
- No OpenClaw approval/input-request, token/context gauges, historical traces, per-chat drill-down, agent orchestration, or full team hierarchy is implemented. Claude Code capabilities remain available through its original provider.
- Linux standalone and a real remote Gateway have been exercised. Unit/fixture coverage is not a claim that every OpenClaw SDK version, Windows/macOS Gateway, VS Code/OpenClaw combination, or native asynchronous child workflow has been manually validated. See the PR's test report for the exact current validation scope.

## Disable, uninstall, rotate

The existing office **Instant Detection (Hooks)** settings toggle controls Claude Code. There is no separate OpenClaw uninstall toggle in this version. To disconnect, run on the actual Gateway host/profile:

```bash
openclaw plugins uninstall pixel-agents-openclaw --force
```

Coordinate any required Gateway restart rather than interrupting active work. Removing a local installation cannot uninstall another host's relay. Uninstall does not automatically revoke the shared office credential or delete your secret provider; remove unused credential material separately when appropriate. Revoke a leaked relay token by stopping all offices sharing that token file, starting one with `--rotate-relay-token`, securely updating the Gateway secret, then reloading the relevant Gateway configuration. Administrative-token rotation uses the separate `--rotate-token` option.

## Troubleshooting and verification

- **No character:** confirm the plugin is enabled/loaded, activity has actually occurred, a workspace is available, workspace filtering permits it, the tunnel/TLS endpoint works, and authentication is valid. Do not print bearer tokens when collecting diagnostics.
- **Wrong name:** set `identity.name` or the plugin `agentNames` override. Existing characters receive new names on subsequent events; no channel configuration is consulted.
- **Too many ordinary characters:** verify stable agent IDs and distinct, stable Gateway namespaces; delegated child sessions are intentionally separate. Missing agent identity falls back to separate sessions.
- **Always idle/active:** check whether the installed OpenClaw version emits model/tool completion hooks. A 250 ms model-end fallback is not authoritative full-turn telemetry.
- **Old child remains:** verify that native completion metadata includes the child's session key. Returning from a background spawn tool alone does not end that child.
- **Server restarted:** trigger new activity; no idle roster replay is implemented.

Development checks (no real LLM or production Gateway required):

```bash
npm run package
npm test
npm run verify:npm-package -- --skip-build
npm run e2e -- e2e/tests/standalone --workers=1
npm run e2e:inventory
```

Relay fixtures exercise names, session merging and priority, lifecycle correlation, content exclusion, late/rotating secrets, endpoint restrictions, child completion, and delivery-order races. Standalone browser tests exercise hook ingress through the real runtime/WebSocket/UI. Real Gateway validation remains a separate manual check; do not equate mocked SDK tests with native end-to-end coverage. The Linux CI blocking checks explicitly run the relay fixtures alongside the existing unit/build/package gates, and the existing cross-platform E2E workflow discovers the standalone specs.
