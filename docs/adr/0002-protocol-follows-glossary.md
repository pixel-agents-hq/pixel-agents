# The wire contract follows the glossary, compatibility yields to vocabulary

When the Directory concept replaced "workspace folder" (CONTEXT.md), the AsyncAPI contract still
spoke folder: `workspaceFolders`, `launchAgent.folderPath`, `folderNames`, folder→Area mappings.
We renamed the wire surface in one breaking sweep (`directories`, `directoryPath`,
`directoryNames`, …) instead of adding directory-named messages beside folder-named fields.

Both ends of the wire ship in lockstep and the contract is young, so the one-time cost falls
almost entirely on hypothetical third-party clients regenerating from the shipped
`core/asyncapi.yaml`. The alternative — additive compatibility — would have left the protocol
speaking two vocabularies permanently, violating the glossary's own _Avoid: folder_ rule in our
canonical artifact. Precedent: when the glossary and the contract disagree, rename the contract.
