# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **JSONL file tracking** — Fixed three related bugs in `knownJsonlFiles` management that caused issues with `/clear` detection and terminal adoption:
  - `adoptTerminalForFile` now adds the JSONL file to `knownJsonlFiles`, preventing repeated adoption attempts on every project scan cycle
  - `reassignAgentToFile` now removes the old file and adds the new file to `knownJsonlFiles`, preventing infinite reassignment loops when `/clear` creates a new session file
  - `removeAgent` now removes the agent's JSONL file from `knownJsonlFiles` on terminal close, preventing stale entries from blocking future `/clear` detection
- **Agent restoration timing** — `sendExistingAgents` now fires immediately after `restoreAgents()` completes, ensuring restored agents are always communicated to the webview regardless of project directory state
- **Layout watcher race condition** — Replaced boolean `skipNextChange` flag with exact mtime matching in the cross-window layout file watcher, preventing legitimate external changes from being incorrectly skipped when multiple VS Code windows write in quick succession
