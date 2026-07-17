# Security model

Version `0.3.0-alpha.1` is intended for controlled tests between trusted collaborators on non-sensitive directories. Do not give links to anonymous users, execute tasks from people you do not trust, or treat this as a hardened sandbox for hostile code.

## What the alpha protects

### Relay confidentiality and integrity

The owner generates a 256-bit random secret locally. HKDF derives two independent values from it and the grant ID:

- a content-encryption key used with AES-256-GCM;
- a relay authentication credential whose SHA-256 digest is stored by the relay.

The URL fragment holds the original secret and is not sent in HTTP requests. Task text, progress, errors, results, and patches are encrypted end to end. AES-GCM additional authenticated data binds each envelope to its grant, request/task ID, and event kind, so swapping or modifying envelopes fails decryption.

The relay still sees routing metadata: grant policy, requested permission names, task status, timestamps, message sizes, source IPs, and traffic timing.

### Capability and abuse limits

- links expire, have a maximum task count, and are revoked when the gateway stops;
- replayed submissions use a UUID idempotency key and do not consume another task slot;
- the relay and gateway independently check requested permissions;
- public deployment can require an operator registration token before a user creates grants;
- request bodies, WebSocket messages, progress history, process output, patch size, direct-workspace inspection, and execution duration are bounded;
- the relay applies per-source-IP rate limits and heartbeat-based dead-connection cleanup.

The relay is currently in-memory. Its rate limiter and replay state do not survive restart and do not stop a distributed denial-of-service attack.

### Local execution boundary

- owner confirmation is required for every task by default; non-interactive approval fails closed;
- worktree mode uses a detached temporary Git worktree at committed `HEAD`; uncommitted owner changes are excluded and the original checkout is not modified;
- direct mode does not require Git or `HEAD` and edits the selected owner directory in place, so it is restricted to per-task interactive approval;
- validation commands are chosen by the owner when sharing, never by the remote sender;
- worktree edit requests that produce no patch, direct edit requests with no detected changed path, and owner validations that exit nonzero fail closed;
- child processes inherit an environment allowlist rather than the complete environment;
- Codex runs ephemerally, ignores user config, uses `read-only` or `workspace-write` sandboxing, disables interactive escalation, and does not enable web search;
- Linux owners must provide a working Bubblewrap/AppArmor user-namespace profile; do not bypass a sandbox initialization failure with `danger-full-access`;
- Claude runs in safe mode without session persistence and receives only explicit file tools; Bash and web tools are not granted.

The worktree is edit isolation, not a complete OS security boundary. Direct mode provides even less isolation: changes happen before validation, failed tasks are not rolled back, and its changed-path snapshot intentionally excludes `.git`, `.adl`, and `node_modules`. The CLIs still need local authentication, and Claude's file-tool restrictions are not equivalent to a container or VM. A compromised agent runtime or undiscovered CLI escape may access more of the host than intended. Use a disposable OS account or VM for higher-risk testing.

`adl setup` stores the Relay registration token as plaintext in the local ADL config because the owner gateway must send it when creating a grant. On POSIX systems ADL creates and requires mode `0600`; never commit, share, or copy this config into a synchronized public folder.

### Audit

The gateway records event type, IDs, permission metadata, and hashes of goals/errors/patches in `.adl/audit.jsonl`; it does not record link secrets or full task/result text. Records form a SHA-256 chain, so accidental or unsophisticated modification is detectable with `adl audit verify`.

This is not a digital signature or externally anchored transparency log. An attacker with write access to the entire file can recompute the chain.

## Link handling

The complete invitation URL is a bearer credential. Anyone who has it can consume the remaining grant within policy.

- transfer it through an end-to-end encrypted channel;
- avoid putting it in tickets, screenshots, CI logs, terminal recordings, or public chat;
- prefer `adl invoke --link-file ...` over a command-line argument so the URL is not saved in shell history;
- store the file with mode `0600` and delete it after the task;
- understand that MCP use exposes the link to the sender's local agent context;
- stop the owner gateway to revoke the link immediately.

## Public relay requirements

ADL refuses non-loopback plain HTTP URLs. Put the relay behind HTTPS/WSS, keep its container port private to the reverse proxy, enable a strong registration token, and set rate limits. The supplied Caddy deployment runs the relay read-only as an unprivileged user with all Linux capabilities dropped.

The current relay has no persistent database, account system, malware scanning, moderation, or distributed abuse defense. Operate it for a small invited test group, not as an unrestricted public service.

## Identity and trust limitations

The `sender` field is self-asserted and not cryptographically authenticated. End-to-end encryption proves possession of the link, not a real-world identity. Signed agent identity, device authorization, persistent delivery, task cancellation, and an external security review remain future work.

## Reporting

Report a vulnerability privately to the repository owner. Do not include active invitation URLs, credentials, private task text, or sensitive patches in an issue.
