# Implementation Plan: Codex Agent Support

## Overview

This plan covers the remaining implementation work for the Codex agent support feature. The Codex provider (`server/src/providers/hook/codex/codex.ts`), constants, hook installer, provider registry, configuration setting, and basic unit tests are already in place. The remaining tasks focus on installing the property-based testing library, writing property tests for the correctness properties defined in the design, and verifying the integration of all components end-to-end.

## Tasks

- [ ] 1. Install fast-check and set up property test infrastructure
  - [ ] 1.1 Add fast-check dependency to server/package.json
    - Run `npm install --save-dev fast-check` in the `server/` directory
    - Verify that `fast-check` is added to `devDependencies` in `server/package.json`
    - _Requirements: Design Testing Strategy_

- [ ] 2. Write property-based tests for Codex provider
  - [ ] 2.1 Create property test file and implement Property 1: Hook event normalization
    - Create `server/__tests__/codex.property.test.ts`
    - Generate random payloads with varying field presence/types using fast-check arbitraries
    - Verify: valid payloads with recognized event names produce correct AgentEvent kinds; payloads missing `session_id` or `hook_event_name` return null; unrecognized event names return null; no exceptions thrown
    - Use `fc.assert(fc.property(...), { numRuns: 100 })` configuration
    - **Property 1: Hook event normalization produces correct event kinds or null**
    - **Validates: Requirements 1.2, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6**

  - [ ]* 2.2 Write property test for Property 2: formatToolStatus length invariant
    - Generate random tool name strings (including very long strings) and input objects with arbitrarily long string values
    - Verify: output length is always ≤ 80 characters; when truncation occurs, result ends with '…' (ellipsis character)
    - **Property 2: formatToolStatus output never exceeds 80 characters**
    - **Validates: Requirements 1.3**

  - [ ]* 2.3 Write property test for Property 3: Transcript line parsing
    - Generate random valid Codex transcript JSON lines (function_call, function_call_output, session_meta, event_msg records) and invalid lines (malformed JSON, unrecognized types)
    - Verify: function_call records produce toolStart with correct toolId/toolName; function_call_output records produce toolEnd; invalid lines return null without throwing
    - **Property 3: Transcript line parsing round-trip correctness**
    - **Validates: Requirements 1.7, 5.1, 5.2, 5.6, 5.7, 5.8**

  - [ ]* 2.4 Write property test for Property 4: Provider resolution always returns valid HookProvider
    - Generate random strings as engine identifiers
    - Verify: always returns a valid HookProvider (never null/undefined); "codex" → codexProvider; "claude-code" → claudeProvider; any other value → claudeProvider
    - **Property 4: Provider resolution always returns a valid HookProvider**
    - **Validates: Requirements 3.4, 3.5, 3.7, 4.4**

  - [ ]* 2.5 Write property test for Property 5: buildLaunchCommand structure
    - Generate random sessionId strings, cwd strings, and boolean bypassPermissions values
    - Verify: always returns an object with non-empty `command` string; when bypassPermissions is true, args contains the bypass flag; when false/undefined, bypass flag is absent
    - **Property 5: buildLaunchCommand structure correctness**
    - **Validates: Requirements 1.6**

  - [ ]* 2.6 Write property test for Property 6: getSessionDirs returns well-formed paths
    - Generate random workspace path strings (including empty, special characters, non-existent paths)
    - Verify: always returns a non-empty array; each element is a string; paths are under the home directory; no exceptions thrown
    - **Property 6: getSessionDirs returns a well-formed path for any workspace**
    - **Validates: Requirements 1.5, 2.1, 2.5**

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Verify dynamic provider injection and hot-swap integration
  - [ ] 4.1 Add integration test for provider hot-swap via configuration change
    - Create or extend `server/__tests__/codex.test.ts` with a test that verifies calling `resolveProvider` with different engine values correctly swaps providers
    - Verify that the `AgentRuntime.configureProvider` method calls `setHookProvider` on both `transcriptParser` and `fileWatcher` modules
    - Verify fallback behavior: invalid engine values resolve to claudeProvider with a console warning
    - _Requirements: 3.6, 3.7, 4.1, 4.2, 4.4, 4.5_

  - [ ]* 4.2 Write integration test for end-to-end hook event flow
    - Simulate posting a Codex hook event payload and verify it normalizes correctly through the provider into the expected AgentEvent
    - Verify that the file watcher's `sessionFilePattern` matches Codex JSONL files
    - _Requirements: 2.2, 2.4, 6.1_

- [ ] 5. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests in `server/__tests__/codex.test.ts` already cover identity, session paths, normalizeHookEvent examples, parseTranscriptLine examples, and formatToolStatus examples
- The Codex provider implementation (`server/src/providers/hook/codex/codex.ts`), constants, hook installer, and provider registry are already complete
- fast-check is the standard PBT library for TypeScript/Vitest projects

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "2.6"] },
    { "id": 3, "tasks": ["4.1"] },
    { "id": 4, "tasks": ["4.2"] }
  ]
}
```
