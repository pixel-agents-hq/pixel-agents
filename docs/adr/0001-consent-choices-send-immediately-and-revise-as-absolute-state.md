# Consent choices send immediately, and a revised choice is an absolute state command

The Intro wraps the first-run hooks consent ask in a four-step tour whose closing step
has a Back button, so an already-answered ask can be re-answered. A consent-step click
sends its `hooksConsentResponse` the moment it happens (no deferred commit on "Let's
Go"), and the server therefore reads every choice as a statement of the state the user
wants _now_, against everything an earlier answer left behind.

Everything below is keyed by `HookProvider.id`. Consent is per-human per-provider
(`hooksConsent` / `hooksEnabled` maps at the top level of `config.json`), every
consent-bearing wire message carries a `providerId` the client only ever echoes, and
one process-wide queue serializes answers across all providers because they share one
`config.json`.

## What an earlier answer can leave behind

Three things, which is why the revision state is `{ installed, consent }` with consent
a TRI-STATE (`'granted' | 'declined'`, absent = unanswered) rather than a boolean:

- **Our hooks on disk.** The obvious one.
- **A grant with nothing on disk.** `install` records the grant _before_ it writes, so
  an install that then failed — the unparseable `settings.json` of issue #377, exactly
  the population this gate exists for — leaves a grant alone. The grant alone retires
  the ask, so a revert keyed only on the install state reads "nothing to undo" and
  leaves the user with an ask that can never come back.
- **A persisted hooks-off the answer itself wrote.** `never` turns the provider's hooks
  preference off, and the ask gate reads a hooks-off preference as never-ask-again.
  `'declined'` is the provenance marker that distinguishes this from a Settings
  toggle-off (which never records consent), so a revised "Not Now" knows the preference
  is its to take back.

## The choice→action rule

`consentActionFor(choice, { installed, consent })`, in `server/src/providers/hook/`:

| choice | nothing left | grant (installed or not) | decline |
| --- | --- | --- | --- |
| `install` | `install` | `install` | `install` |
| `never` | `persistOff` | `disable` if installed, else `persistOff` | `persistOff` |
| `notNow` | `none` | `revert` | `revertDecline` |
| anything else | `none` | `none` | `none` |

- `install` grants and installs through the same path as the Settings toggle. A grant
  REPLACING a decline also deletes that decline's hooks-off remnant in the same write:
  without it, `never → install (which fails) → notNow` ends at unanswered + hooks-off,
  an ask suppressed forever although the final answer asked for it to return.
- `disable` takes the full toggle-off path — uninstall, then persist hooks-off only
  once the disk agrees — because a persisted hooks-off beside live entries is the
  stranding bug: entries firing, checkbox lying, gate skipped.
- `revert` undoes the install and clears the consent record, leaving the preference
  alone: a granted install never wrote it, and resetting it would clobber a genuine
  Settings toggle-off made between answer and revision.
- `revertDecline` clears the record AND restores the preference default by deleting the
  key, so "never answered" and "answered and reverted" are indistinguishable on disk —
  which is exactly what "the world as if never answered" means.
- Every unrecognized value writes nothing: junk must never read as approval, as a
  durable decline, or as an uninstall trigger.

Callers pass a fresh `areHooksInstalled()` and degrade an unreadable settings file to
`installed: false`, so no choice ever uninstalls on a guess.

## Considered options

- **Deferred commit** — record the choice locally and send once, at "Let's Go". Keeps
  the one-answer-per-ask invariant by construction and needs no revision semantics.
  Rejected: a user who clicks Install and then closes the tour with the close x (or
  loses the window) would have their explicit decision silently discarded.
- **Immediate send with one-shot semantics** — rejected because replaying
  `never → persist hooks-off, touch nothing` after an install recreates the stranding
  bug described above.
- **A boolean consent record** — rejected because it cannot express the failed-install
  grant or the decline's own preference write, and both of those are things a revision
  has to undo.

## Consequences

- **One answer is one config write.** `recordHooksDecline` (consent + preference off)
  and `clearHooksAnswer` (both keys deleted) are single `readConfig`→`writeConfig`
  cycles. Split across two writes, a failed second write leaves a state the answer
  disavows — a decline with the default-on preference, or a hooks-off with no
  provenance. The surface effect only mirrors the result into live runtime state.
- **Answers are serialized.** Revision is the whole point of this decision, so two
  answers in quick succession are designed for, not an edge case — and both surfaces
  dispatch without awaiting. An unserialized revision can observe the first answer's
  install mid-flight, read `installed: false`, and degrade into its no-op variant,
  leaving hooks installed against the user's final answer. `consentExecutor.ts` holds
  one queue per process, which is where the Back-and-revise race lives; two separate
  windows racing is a different problem, and the installer's re-read-before-rename is
  what narrows that one.
- **The webview keeps the tour mounted after its own choice.** The install's
  `hooksStatus installed: true` broadcast moots an _unanswered_ ask but must not yank
  the closing step from the person who just answered, so the tour snapshots the request
  and gates the moot on a sent choice.
- **The closing step reports the outcome, not the click.** An install can fail for
  reasons unrelated to the answer, and a tour that congratulates regardless leaves the
  user believing hooks are running over a file that was never written. The verdict
  settles on the ARRIVAL of a `hooksStatus` (`hooksStatusSeq`, per provider), because a
  failed install re-reports the same `false` the webview already held — the value never
  changes, only the message arrives, and another provider's status is not this tour's
  verdict.
- **Asks queue per provider.** The server sends one request per provider that needs
  one; the webview renders the head and advances on answer or dismissal, and a request
  for a different provider starts a clean tour rather than inheriting the previous
  provider's sent choice or armed wait.
