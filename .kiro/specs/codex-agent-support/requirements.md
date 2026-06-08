# Requirements Document

## Introduction

This feature extends the Pixel Agents VS Code extension to support OpenAI's Codex CLI as an AI agent provider alongside the existing Claude Code integration. The extension currently uses the `HookProvider` interface in its core architecture, with a single Claude Code implementation. This feature adds a Codex provider implementation, a configuration option for agent selection, and dynamic provider injection at startup so users can choose which AI agent engine drives their pixel office visualization.

## Glossary

- **Extension**: The Pixel Agents VS Code extension that visualizes AI agent activity as pixel art characters
- **Provider_Registry**: The module (`server/src/providers/index.ts`) that exports all bundled HookProvider implementations
- **HookProvider**: The interface defined in `core/src/provider.ts` that normalizes CLI-specific events into standard AgentEvent types
- **Codex_Provider**: The new HookProvider implementation for OpenAI's Codex CLI agent
- **Claude_Provider**: The existing HookProvider implementation for Anthropic's Claude Code CLI agent
- **Agent_Runtime**: The server module (`server/src/agentRuntime.ts`) that bootstraps agent detection and event processing
- **Transcript_Parser**: The module (`server/src/transcriptParser.ts`) that processes JSONL log lines into agent activity events
- **File_Watcher**: The module (`server/src/fileWatcher.ts`) that detects and monitors agent session files
- **AgentEvent**: The normalized event union type produced by all providers (toolStart, toolEnd, turnEnd, sessionStart, etc.)
- **Configuration_Setting**: A VS Code `contributes.configuration` property that users can set via the Settings UI or settings.json
- **Session_Directory**: The filesystem path where an AI agent stores its session transcript files
- **Codex_Log**: The log/transcript file produced by the Codex CLI during execution

## Requirements

### Requirement 1: Codex Provider Implementation

**User Story:** As a developer using OpenAI Codex CLI, I want Pixel Agents to visualize my Codex sessions as animated characters, so that I can monitor Codex agent activity in the same way Claude Code users do.

#### Acceptance Criteria

1. THE Codex_Provider SHALL implement the HookProvider interface defined in `core/src/provider.ts`, exposing `kind: 'hook'`, a unique `id`, `displayName`, and `protocolVersion` fields
2. THE Codex_Provider SHALL normalize raw Codex hook event payloads into standard AgentEvent types (toolStart, toolEnd, turnEnd, sessionStart, sessionEnd, permissionRequest) and return null for event types that have no corresponding AgentEvent mapping
3. THE Codex_Provider SHALL provide a `formatToolStatus` method that accepts a tool name and optional input, and returns a status string of the form "[Action verb] [target]" (e.g. "Reading foo.ts", "Running: ls") with a maximum total length of 80 characters including the ellipsis, truncating the content to 77 characters plus '...' when the full string would exceed 80 characters
4. THE Codex_Provider SHALL define `permissionExemptTools` containing tools that do not require user confirmation, `subagentToolNames` containing tools that spawn child agent processes, and `readingTools` containing tools that perform read-only operations, each populated according to the Codex CLI's documented tool set
5. THE Codex_Provider SHALL provide a `getSessionDirs` method that returns an array containing the filesystem path where Codex CLI stores session transcript files for the given workspace path, following the Codex CLI's transcript storage convention under the user's home directory
6. THE Codex_Provider SHALL provide a `buildLaunchCommand` method that returns an object containing the `command` string set to the Codex CLI executable name, an `args` array including the session ID, and an optional `env` record, accepting a `bypassPermissions` option that appends the appropriate Codex CLI flag when true
7. WHEN a Codex transcript line is received, THE Codex_Provider SHALL parse it via `parseTranscriptLine` and return the corresponding AgentEvent if the line represents a tool invocation, tool completion, turn completion, session lifecycle, or permission request, or return null if the line represents assistant text output or other non-actionable content

### Requirement 2: Codex Session Directory Discovery

**User Story:** As a developer using Codex CLI, I want the extension to automatically detect my active Codex sessions, so that agents appear in the pixel office without manual configuration.

#### Acceptance Criteria

1. THE Codex_Provider SHALL implement `getSessionDirs(workspacePath)` that returns an array containing the Codex CLI session transcript directory path derived from the given workspace path, following the same home-directory-relative convention used by the Codex CLI for storing session logs
2. THE Codex_Provider SHALL define `sessionFilePattern` as a glob string that matches only Codex transcript files within the Session_Directory (e.g., `*.jsonl`)
3. THE Codex_Provider SHALL implement `getAllSessionRoots()` that returns an array containing the single root directory under which all Codex session subdirectories reside, enabling global session discovery across workspaces
4. WHEN a new file matching `sessionFilePattern` appears in a directory returned by `getSessionDirs`, THE File_Watcher SHALL detect the file within 5 seconds and create a corresponding agent character in the pixel office
5. IF the Codex CLI session directory does not exist on disk, THEN THE Codex_Provider `getSessionDirs` method SHALL return the expected path string in the array without throwing an error, allowing the File_Watcher to begin monitoring once the directory is created
6. IF the Session_Directory exists but cannot be read due to filesystem permissions, THEN THE File_Watcher SHALL skip that directory without throwing an unhandled error, SHALL log the permission error internally at warning level, and SHALL NOT create agent characters for that directory

### Requirement 3: Agent Engine Configuration Setting

**User Story:** As a user of Pixel Agents, I want to select which AI agent engine the extension monitors, so that I can use the extension with my preferred AI coding assistant.

#### Acceptance Criteria

1. THE Extension SHALL register a Configuration_Setting named `pixel-agents.agentEngine` with type `string` and enum values limited to "claude-code" and "codex", within the existing `contributes.configuration` section of `package.json`
2. THE Configuration_Setting SHALL default to "claude-code" so that existing users experience no change in behavior upon upgrade
3. THE Configuration_Setting SHALL include a description property explaining that it controls which AI coding assistant the extension monitors for agent activity
4. WHEN the Configuration_Setting value is "codex", THE Agent_Runtime SHALL inject the Codex_Provider as the active HookProvider used for session detection, event normalization, and terminal launch
5. WHEN the Configuration_Setting value is "claude-code", THE Agent_Runtime SHALL inject the Claude_Provider as the active HookProvider used for session detection, event normalization, and terminal launch
6. WHEN the user changes the Configuration_Setting value, THE Extension SHALL apply the new provider immediately regardless of the extension's current activation state, without requiring a manual reinstall or reload
7. IF the Configuration_Setting value does not match any registered provider enum value, THEN THE Agent_Runtime SHALL fall back to the Claude_Provider and log a warning message identifying the invalid value

### Requirement 4: Dynamic Provider Injection

**User Story:** As a developer, I want the extension to use the correct provider based on my configuration, so that the agent detection, event parsing, and session management all operate against the selected engine.

#### Acceptance Criteria

1. WHEN the extension activates, THE Agent_Runtime SHALL read the `pixel-agents.agentEngine` configuration value, resolve it to a registered HookProvider by matching the value against provider IDs in the Provider_Registry, and pass the selected HookProvider to the Transcript_Parser via `setHookProvider`
2. WHEN the extension activates, THE Agent_Runtime SHALL pass the selected HookProvider to the File_Watcher via `setHookProvider`
3. THE Provider_Registry SHALL export the Codex_Provider alongside the existing Claude_Provider so that both are available for resolution by configuration value
4. IF the configured agent engine value does not match any registered provider ID, THEN THE Agent_Runtime SHALL fall back to the Claude_Provider and log a warning message to the console indicating the unrecognized configuration value that was provided
5. WHEN the `pixel-agents.agentEngine` configuration value changes at runtime, THE Extension SHALL immediately re-resolve the provider from the Provider_Registry and re-inject it into the Transcript_Parser and File_Watcher without requiring a reload

### Requirement 5: Codex Transcript Parsing

**User Story:** As a Codex CLI user, I want the extension to parse Codex transcript files accurately, so that tool usage, turn boundaries, and session lifecycle are correctly reflected in the pixel office.

#### Acceptance Criteria

1. WHEN a Codex transcript line contains an assistant message with one or more tool_use blocks, THE Codex_Provider SHALL emit a toolStart AgentEvent for each tool_use block, including the block's id as toolId, the block's name as toolName, and the block's input object as input
2. WHEN a Codex transcript line contains a user message with one or more tool_result blocks, THE Codex_Provider SHALL emit a toolEnd AgentEvent for each tool_result block, with toolId set to the corresponding tool_use_id
3. WHEN a Codex transcript line contains a system record indicating a turn boundary (e.g., turn_duration subtype), THE Codex_Provider SHALL emit a turnEnd AgentEvent
4. WHEN a Codex transcript line contains a record indicating that a session has started, THE Codex_Provider SHALL emit a sessionStart AgentEvent with transcriptPath set to the session file path if available, and cwd set to the working directory if available
5. WHEN a Codex transcript line contains a record indicating that a session has ended, THE Codex_Provider SHALL emit a sessionEnd AgentEvent with the reason field set to the termination reason if provided in the record
6. IF a Codex transcript line cannot be parsed as valid JSON or contains an unrecognized record type, THEN THE Codex_Provider SHALL return null without throwing an exception and SHALL log the parsing failure at debug level for diagnostic purposes
7. THE Codex_Provider SHALL implement the parseTranscriptLine method conforming to the HookProvider interface signature, accepting a single line string and returning either an AgentEvent or null
8. WHEN a Codex transcript line contains an assistant message with tool_use blocks, THE Codex_Provider SHALL set the toolStart event's toolId to a value that uniquely identifies the tool invocation within the session, enabling correlation with the subsequent toolEnd event

### Requirement 6: Codex Hook Event Normalization

**User Story:** As a Codex CLI user with hooks enabled, I want real-time hook events from Codex to be normalized into the standard event format, so that the extension responds instantly to agent activity.

#### Acceptance Criteria

1. WHEN a raw Codex hook event payload is received, THE Codex_Provider SHALL extract the session ID as a string and event type as a string from the payload and return an object containing the sessionId and the corresponding AgentEvent
2. IF the raw hook event payload is missing required fields (session ID or event type) or either field is not a string, THEN THE Codex_Provider SHALL return null without throwing an error
3. WHEN the extracted event type maps to a tool-use start event, THE Codex_Provider SHALL produce a toolStart AgentEvent that includes a generated toolId, the tool name extracted from the payload (defaulting to an empty string if absent), and the tool input extracted from the payload (defaulting to an empty object if absent)
4. WHEN the extracted event type maps to a tool-use completion event, THE Codex_Provider SHALL produce a toolEnd AgentEvent with a sentinel toolId value of "current"
5. WHEN the extracted event type maps to a session lifecycle event, THE Codex_Provider SHALL produce the corresponding sessionStart or sessionEnd AgentEvent, including optional metadata fields (source, cwd, reason) when present in the payload as strings
6. IF the extracted event type does not match any recognized Codex event name, THEN THE Codex_Provider SHALL return null without throwing an error

### Requirement 7: Provider File Structure Convention

**User Story:** As a contributor to Pixel Agents, I want the Codex provider to follow the same directory and file conventions as the Claude provider, so that the codebase remains consistent and maintainable.

#### Acceptance Criteria

1. THE Codex_Provider source files SHALL reside in `server/src/providers/hook/codex/`
2. THE Codex_Provider main module SHALL be a file named `codex.ts` that implements the `HookProvider` interface and exports the provider instance as `codexProvider`
3. THE Codex_Provider SHALL have a file named `constants.ts` that exports Codex-specific constants including at minimum a terminal name prefix string constant
4. THE Provider_Registry in `server/src/providers/index.ts` SHALL export `codexProvider` from the path `./hook/codex/codex.js`
