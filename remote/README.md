# Remote sessions: setup

Shows every Claude Code session in the office: this PC, your other computers, and cloud sessions (claude.ai/code).
This PC runs the board and a small relay. Only the relay is reachable from the internet, through Tailscale Funnel.
Other machines send their hook events to it over HTTPS, each with its own key. Design: [docs/remote/DESIGN.md](../docs/remote/DESIGN.md).

```
this PC         Claude Code ── local hook ───────────────────► board 127.0.0.1:3100 (private)
                                                                   ▲
other computer ── curl + key ──┐                                   │ loopback + board token
                               ├─► Tailscale Funnel ──► relay 127.0.0.1:3199
cloud session ─── curl ────────┘   https://<host>/ingest
                  (key added by a network secret)
```

Run the commands on this PC from the root of the pixel-agents checkout. You need Node.js 20 or later.
Below, `<host>` is your Funnel name, `<machine>.<tailnet>.ts.net` (step 2 shows it).

The host can be a Windows PC or a Mac. Sections 1 and 2 are written for Windows; on a Mac, follow
[Mac host](#mac-host) for the steps that differ. Everywhere else, "this PC" means whichever machine hosts the board.
It must stay awake: while it sleeps or is off, the board is down and events sent to it are lost.

## 1. This PC (board + relay + autostart)

1. Build the board:

   ```powershell
   npm ci
   npm run build
   ```

2. Start it once by hand:

   ```powershell
   node dist/cli.js --port 3100 --no-terminal
   ```

3. Open the printed URL that ends in `?token=...`. Treat it as a secret. In **Settings** turn on:
   - **Instant Detection (Hooks)**: installs the local hook into `~/.claude/settings.json` (asks for consent).
   - **Watch All Sessions**: shows every local project, not only this one.
   - **Always Show Labels**: keeps the ☁/💻 origin line visible on a wall display.

   The settings are saved. Stop the board with **Ctrl+C**.

4. Create one source per sender. Each command prints its key **once**. Copy it now.

   ```powershell
   node remote/relay/relay.mjs add-source laptop --kind computer --label "Laptop"
   node remote/relay/relay.mjs add-source cloud --kind cloud --label "Cloud"
   node remote/relay/relay.mjs list
   ```

   Only a SHA-256 hash of each key is stored, in `~/.pixel-agents/relay.json`.
   `node remote/relay/relay.mjs remove-source <id>` revokes a source immediately. The running relay picks up changes without a restart.
   Lost a key? Run `add-source` again with the same id. It gets a new key and the old one stops working.

5. Start the board and the relay at every logon:

   ```powershell
   powershell -ExecutionPolicy Bypass -File remote\windows\autostart.ps1 -Install
   powershell -ExecutionPolicy Bypass -File remote\windows\autostart.ps1 -Status
   ```

   `-Install` registers two logon Scheduled Tasks (board on :3100, relay on 127.0.0.1:3199). They run hidden and restart on failure.
   Logs go to `~/.pixel-agents/logs/`. `-Uninstall` removes both tasks.
   To run the relay by hand instead: `node remote/relay/relay.mjs serve`.

6. On the second monitor, open `http://127.0.0.1:3100` (no token) and press **F11**.
   A tab without the token is read-only, which is what a wall display wants.
   To approve and answer questions from the wall display, open the private `?token=...` URL instead and add `&tv=1`
   (or press **T**): in TV mode every pending approval or question opens its own card. Closing a card leaves that
   request to the terminal; click the agent to open it again.

## 2. Public address (Tailscale Funnel)

1. Install Tailscale on this PC and sign in:

   ```powershell
   winget install Tailscale.Tailscale
   ```

2. In the Tailscale admin console, enable **HTTPS certificates** and allow **Funnel** for this machine.
   If Funnel isn't allowed yet, the next command prints a link to fix it.

3. Publish only the relay's path:

   ```powershell
   tailscale funnel --bg --set-path /ingest http://127.0.0.1:3199
   tailscale funnel status
   ```

   `status` shows the public URL: `https://<machine>.<tailnet>.ts.net/ingest`.
   Only `/ingest` is public. The board on :3100 is never exposed.
   The relay accepts both `/ingest` and `/`, so it works whether or not Funnel strips the mount path.

4. Check from any network:

   ```bash
   curl -i -X POST https://<host>/ingest
   ```

   Expect `401` (no key). That means Funnel reaches the relay.

5. Optional, watch from your phone: install the Tailscale app on the phone and sign in to the same
   tailnet. Then, on this PC, serve the board **inside the tailnet only**, on its own port:

   ```powershell
   tailscale serve --bg --https=3443 http://127.0.0.1:3100
   tailscale serve status
   ```

   Open `https://<host>:3443` on the phone and add it to the home screen. It is read-only (no token).
   Funnel is switched on per port, so the board must never share port 443 with the Funnel:
   `status` must show Funnel on `:443` only, and `curl -i https://<host>:3443` from a device
   that is **not** on the tailnet must fail to connect.

## Mac host

Sections 1 and 2 work on a Mac with these changes. Run everything in Terminal from the checkout root.

1. **Build and first start**: same as section 1, steps 1–4 (`npm ci`, `npm run build`, `node dist/cli.js --port 3100 --no-terminal`,
   Settings, `add-source`). Moving from a Windows host? See [Moving the host](#moving-the-host-from-a-pc-to-a-mac) first.

2. **Autostart** instead of section 1, step 5:

   ```bash
   bash remote/mac/autostart.sh            # install + start; re-run after npm run build or a Node upgrade
   bash remote/mac/autostart.sh --status
   bash remote/mac/autostart.sh --uninstall
   ```

   It installs two LaunchAgents, `com.pixel-agents.board` (:3100) and `com.pixel-agents.relay` (127.0.0.1:3199),
   in `~/Library/LaunchAgents`. They start at login, restart 10 s after any exit, and log to `~/.pixel-agents/logs/`.
   No sudo. The agents use the `node` and the `PATH` of the shell you install from (the board runs `claude`), so
   install from a shell where `node` and `claude` work. `--print-plist board` shows what it would install.
   If Tailscale is already set up, the board also accepts this Mac's Tailscale name, as on Windows; pass
   `--allowed-host <name>` to choose it yourself.

3. **Keep it awake.** With the default settings a Mac sleeps and the board goes down.

   ```bash
   sudo pmset -c sleep 0          # never sleep while on power (the display may still sleep)
   sudo pmset -a autorestart 1    # Mac mini / iMac / Studio: start again after a power cut
   pmset -g                       # check: sleep 0
   ```

   The same switches are in System Settings: **Energy** (desktop Macs) or **Battery → Options** (MacBooks),
   "Prevent automatic sleeping … when the display is off". A MacBook still sleeps when its lid closes unless an
   external display is attached; `sudo pmset -a disablesleep 1` keeps it awake with the lid shut (`0` undoes it;
   it applies on battery too).

4. **After a reboot**, LaunchAgents start only once you log in. For an unattended Mac, turn on
   System Settings → Users & Groups → **Automatically log in as**. macOS doesn't offer it while FileVault is on;
   then the board comes back when you next log in.

5. **Tailscale** instead of section 2, step 1: install the macOS app from <https://tailscale.com/download/mac> and sign in.
   If `tailscale` isn't a command in Terminal, use the app's binary:

   ```bash
   alias tailscale=/Applications/Tailscale.app/Contents/MacOS/Tailscale
   ```

   Section 2, steps 2–5 (Funnel on `/ingest`, the `curl` check, the phone on `:3443`) are the same commands.
   If `tailscale funnel` refuses on the App Store build, install the standalone build from the same page.
   Run `autostart.sh` again after Tailscale is signed in, so the board picks up the Mac's Tailscale name.

6. **Wall display**: open `http://127.0.0.1:3100` and press **Ctrl+Cmd+F** for full screen.

### Moving the host from a PC to a Mac

1. On the PC, stop serving: open the board's **Settings** and turn off **Instant Detection (Hooks)** (its local hook has
   nowhere to post once the board is gone), then

   ```powershell
   powershell -ExecutionPolicy Bypass -File remote\windows\autostart.ps1 -Uninstall
   tailscale serve reset   # removes the PC's Funnel and Serve config
   ```

2. Copy the PC's `%USERPROFILE%\.pixel-agents\relay.json` to `~/.pixel-agents/relay.json` on the Mac **before** running
   `add-source` there. It holds only the key hashes, so every existing key keeps working and no sender needs a new key.
   (Or skip it and create fresh sources on the Mac.)
3. Set up the Mac as above. Its Funnel name is new, so every sender needs the new URL:
   - other computers: re-run `sender-config --url https://<mac-host>/ingest` and replace their hook entries;
   - cloud repos: the committed `.claude/settings.json` hooks, and the network secret's **Allowed website**.
4. The PC is now a sender like any other computer (section 3): add a `pc` source, save its key in
   `%USERPROFILE%\.pixel-agents\ingest-key`, and merge `sender-config` into the PC's `~/.claude/settings.json`
   (add `--shell powershell` if the PC has no Git Bash). Its sessions show as 💻, without a context gauge
   or team detection; those need the transcript, which stays on the PC. Board approvals work (see section 3).

## 3. Another computer

Works from any network. Needs `bash` and `curl`: macOS, Linux, or Windows with Git Bash
(Claude Code runs hooks in bash when Git Bash is installed). Windows without Git Bash: see the
note at the end of this section. Use one source per computer.

1. On that computer, save its source key (`laptop` above):

   ```bash
   mkdir -p ~/.pixel-agents
   cat > ~/.pixel-agents/ingest-key       # paste the key, press Enter, then Ctrl+D
   chmod 600 ~/.pixel-agents/ingest-key   # macOS/Linux
   ```

2. On **this PC**, print the hooks block:

   ```powershell
   node remote/relay/relay.mjs sender-config --url https://<host>/ingest
   ```

3. Merge the printed `{"hooks": {...}}` block into `~/.claude/settings.json` on the other computer.
   Merge per event: add to existing hook lists, don't replace them.
   Easiest: paste the block into a Claude Code session on that machine and ask it to merge it into `~/.claude/settings.json`.

4. Check the key. The empty body is rejected on purpose, so no test character appears:

   ```bash
   curl -i -X POST -H "Authorization: Bearer $(cat ~/.pixel-agents/ingest-key)" -d '{}' https://<host>/ingest
   ```

   Expect `400`. `401` means the key is wrong.

5. Start a new Claude Code session there. A 💻 character appears on the board.

Every event hook is `async: true` and uses `curl -m 5`, so sessions never wait, even when this PC is off.

**Approvals from the board.** `PermissionRequest` also gets a second, synchronous hook that posts to
`https://<host>/ingest/permission` and waits for the board (up to 10 minutes). The terminal's own dialog is up the whole
time; whichever answers first wins. Allow / Deny on the board, or the options of a multiple-choice question (Claude's
`AskUserQuestion`), go back to that session. When the board can't answer (this PC off, approvals switched off, nobody
answers) the hook prints nothing and the terminal decides, as before. Answering in the terminal ends the hook, and the
board's card closes. Leave it out with `sender-config ... --no-approvals`. Already set up? Re-run `sender-config` and
add the new second `PermissionRequest` entry (the one without `"async": true`) to that computer's settings.

**Usage meter.** `sender-config` also prints a `statusLine` (computers only). Claude Code tells only a status line the
subscription's 5-hour and weekly usage, so this one posts its input to `https://<host>/ingest/usage`; the relay passes
the two usage numbers (nothing else: no paths, no session) to the board's meter and answers with the line to show,
`Opus 5.5 | 5h 23% (resets 6:30 PM) | 7d 41%`. Offline, the status line is empty. It **replaces** any status line that
computer already has; skip it with `--no-usage`. Put it at the top level of `~/.claude/settings.json`, beside `hooks`.

**Windows without Git Bash.** Use PowerShell hooks instead (Windows PowerShell 5.1 or PowerShell 7).
Steps 3 and 5 stay the same.

- Step 1, save the key in PowerShell:

  ```powershell
  New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.pixel-agents" | Out-Null
  Set-Content -NoNewline -Path "$env:USERPROFILE\.pixel-agents\ingest-key" -Value '<key>'
  ```

- Step 2, add `--shell powershell`. Each hook gets `"shell": "powershell"` and posts with `Invoke-RestMethod` (5 s timeout, still async):

  ```powershell
  node remote/relay/relay.mjs sender-config --url https://<host>/ingest --shell powershell
  ```

- Step 4, check the key with `curl.exe`. In Windows PowerShell, plain `curl` is `Invoke-WebRequest`:

  ```powershell
  $key = (Get-Content -Raw "$env:USERPROFILE\.pixel-agents\ingest-key").Trim()
  curl.exe -i -X POST -H "Authorization: Bearer $key" -d '{}' https://<host>/ingest
  ```

## 4. Cloud sessions

Covers claude.ai/code sessions, including ones started from the phone or the desktop app.
Cloud sessions read only the repo's committed `.claude/settings.json`, not user settings, so this is per repo.

1. On this PC, print the cloud hooks block:

   ```powershell
   node remote/relay/relay.mjs sender-config --url https://<host>/ingest --cloud
   ```

2. For each repo you use in the cloud: merge the block into that repo's `.claude/settings.json`
   (per event, as above), then commit and push it.
   These hooks exit at once unless `CLAUDE_CODE_REMOTE=true`, so they are a no-op on local machines. They carry no key.

3. In claude.ai/code, open the environment's settings → **Network secrets** → **Add secret**:
   - Type: **Bearer**
   - Allowed website: `<machine>.<tailnet>.ts.net`
   - Header: `Authorization`, prefix: `Bearer`
   - Value: the `cloud` source key

   The agent proxy attaches the key outside the VM, so the key never enters the session.
   A host listed on a network secret is reachable even at the default **Trusted** network level.
   On a Team plan without the admin role the form is shorter: one Host and a Token.

4. Start a cloud session in that repo. A ☁ character appears.

## What you'll see

- Remote sessions appear within about 2 s of activity, labeled like `☁ Cloud · repo` or `💻 Laptop · repo`.
- Tool activity, the permission bubble, Done/Waiting, and Subtask mini-characters work.
- No context gauge and no team detection. Both need the transcript, which stays on the other machine.
- A remote session with no events for 3 h is removed. A sleeping laptop or a stopped cloud VM never sends SessionEnd.
- Async hooks can arrive out of order. Worst case, a tool row lingers until the turn ends.
- The board updates only while this PC is on. Senders fail silently when it's off.
- claude.ai chats don't appear. They have no hooks.

## Security

- Only `POST /ingest` is public. The board and its own token never leave this PC.
- Each source has its own key. A key can only post events. `remove-source <id>` revokes it at once.
- Session ids are prefixed with the source id, so a remote key can't touch local sessions.
- The relay drops tool output and transcript paths and truncates tool inputs.
- Events still contain file paths and commands (truncated). They travel over HTTPS to your own PC.
- Keep the `?token=` URL private. Whoever holds it can install hooks on this PC.

## Troubleshooting

- Check the tasks: `powershell -ExecutionPolicy Bypass -File remote\windows\autostart.ps1 -Status` (Mac: `bash remote/mac/autostart.sh --status`). Logs are in `~/.pixel-agents/logs/`.
- Mac: the agents keep restarting and `board.log` shows nothing new: read `~/.pixel-agents/logs/board.launchd.log`
  (the wrapper's own errors, such as a `node` that moved after an upgrade; re-run `autostart.sh` to fix the path).
- Mac: `autostart.sh` stops with "port 3100 is in use": a board started by hand is still running. Stop it and re-run.
- `curl` gets `401`: the key is wrong or missing.
- `curl` gets `404`: wrong path, or not a `POST`.
- The relay answers `204` but nothing shows: the board isn't running. Check `-Status` and the logs.
  Watch All Sessions is irrelevant here; remote sessions don't need it.
- A cloud session shows nothing: check the network secret's host matches `<host>` exactly, and that the hooks are
  committed in `.claude/settings.json` on the branch the session starts from.
- `sender-config` rejects the URL: it must be a plain `https://` URL with no quotes or spaces.
- Lost or leaked key: run `add-source <id>` again with the same id and update that sender.
