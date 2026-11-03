# A look is a palette and a repeat, renamed on the wire in one breaking sweep

When character profiles replaced the six bundled `char_N.png` sheets, an agent's look stopped
being "sprite set N turned by some degrees" (`hueShift`). It became "character N, copy k": the
office draws the kth copy of a character with its clothes in the kth colour of a fixed list. The
degrees had no meaning left, so we renamed the wire surface in one breaking sweep instead of
keeping `hueShift` beside `repeat`:

- `agentCreated.hueShift` → `repeat`; `AgentSeatMeta` and `SeatAssignment` likewise (`repeat` is
  required on `SeatAssignment` where `hueShift` was). The `StateAdapter` seat records follow.
- Palette N is profile N (`characterProfilesLoaded`), then the external sprites.
  `characterSpritesLoaded` now carries only the external `char_N.png` sheets. It may be empty,
  and it is always sent.

This follows ADR 0002: both ends of the wire ship in lockstep, so the cost falls on third-party
clients regenerating from the shipped `core/asyncapi.yaml`. Keeping `hueShift` optional beside
`repeat` would have left a field whose meaning is gone in the canonical contract.

Persisted state is not on the wire and keeps reading the old form. A saved agent's `hueShift`
(or the `clothesHue` of unreleased builds) reads as a repeat (non-zero = 1,
`agentPersistence.ts` `legacyRepeat`), so an upgrade loses no look.
