# Security status

Version 0.1 is a local development prototype. Do not expose its relay to the public internet or use it with sensitive repositories.

## Implemented boundaries

- Invitation secrets are generated client-side; the relay stores only a SHA-256 digest.
- Links expire, have a maximum task count, and can be revoked by the owner gateway.
- Requested task permissions must be a subset of the link permissions.
- Agent processes receive an allowlisted environment instead of the full parent environment.
- Each task runs in a disposable Git worktree and returns a patch. The owner's checkout is not modified.
- Validation commands are configured by the owner when creating the link; the remote task cannot supply commands.
- Claude is launched with safe mode and an explicit tool set. Codex is launched with ignored user config and its workspace sandbox.

## Known v0.1 limitations

- Transport is not end-to-end encrypted. The relay can read task and result content.
- The relay is in-memory and has no authenticated administrative control plane.
- A Git worktree isolates repository edits but is not an operating-system sandbox.
- Claude tool restrictions and Codex's built-in sandbox reduce risk but do not replace a container or VM security boundary.
- Link secrets can leak through shell history, chat transcripts, screenshots, or logs.
- Interactive `ask_every_time` approval is intentionally rejected until an owner approval UI exists.
- There is no artifact size quota beyond request/output limits and no malware scanning.

## Before a public alpha

1. Add end-to-end encryption with keys derived from the URL fragment.
2. Persist only encrypted relay envelopes and minimal routing metadata.
3. Run delegated agents inside a hardened container/VM with no inherited credentials.
4. Add an owner approval UI and policy presets.
5. Add replay protection, rate limiting, audit signing, and abuse controls.
6. Add resumable delivery and explicit offline/queued states.
7. Commission an external security review.
