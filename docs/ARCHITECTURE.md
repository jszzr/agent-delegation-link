# Architecture

## Core abstraction

An invitation URL is a task-scoped capability to one local coding agent, not membership in a shared workspace.

```text
Sender agent -> CLI/MCP -> HTTPS relay <- WSS gateway -> policy/approval -> local agent
```

Both user-side components create outbound connections. Only the relay needs a public address, which allows users on unrelated networks and behind NAT to collaborate without opening local ports.

## Trust boundaries

The sender and owner share the invitation secret. The relay is trusted for availability and policy metadata enforcement, but not for task confidentiality. The local gateway is the final policy authority. The coding agent receives untrusted task text only after decryption and optional owner approval.

The first alpha targets trusted invited collaborators. It does not claim that a Git worktree alone contains a malicious model, CLI runtime, repository, or validator.

## Grant creation

1. The gateway creates a random grant ID and 256-bit secret.
2. HKDF-SHA-256 derives separate content-encryption and relay-authentication keys, salted by the grant ID and protocol version.
3. The gateway sends the relay only the digest of the relay credential and public policy.
4. The original secret is placed after `#secret=` in the invitation URL.
5. The relay returns a separate random owner token. Its digest is kept in memory, and the raw token is sent only in the gateway WebSocket authorization header.
6. An optional operator registration token restricts who may create grants on a hosted relay.

## Encrypted task lifecycle

```text
queued -> running -> completed
                  -> failed
```

The sender validates the structured request locally, creates a UUID idempotency key, encrypts the request with AES-256-GCM, and submits only requested permission names plus the envelope. The relay can reject obviously out-of-scope permissions without decrypting the goal.

Additional authenticated data binds request envelopes to `(grant ID, client request ID)` and response envelopes to `(grant ID, task ID, event kind)`. The gateway rejects a request if the encrypted permissions do not exactly match the relay-visible copy.

Tasks can remain encrypted in the relay while the owner is offline. The gateway reconnects with exponential backoff, the relay reoffers unfinished tasks, and the in-process gateway prevents duplicate execution. Terminal events are replayed after reconnect. A relay restart currently loses all grants and tasks.

## Execution boundary

The gateway serializes tasks. After approval it:

1. creates a detached temporary worktree at repository `HEAD`;
2. launches the selected agent with bounded time/output and a reduced environment;
3. runs only owner-configured validators when `test` permission was requested;
4. captures changed paths and `git diff --binary HEAD` under the grant's artifact limit;
5. encrypts the structured result for the sender;
6. destroys the worktree.

The returned patch is never applied automatically by ADL. The sender or sender agent must review it and choose whether to run `git apply`.

## Adapter boundary

Adapters implement:

```ts
execute({ task, cwd, permissions, timeoutMs, onProgress })
```

Codex uses an ephemeral JSONL `codex exec` session with ignored user config, `never` approval, and an OS-enforced `read-only` or `workspace-write` sandbox. Claude uses print-mode stream JSON, safe mode, no persistence, a constrained permission mode, and only `Read/Glob/Grep` plus `Edit/Write` when granted.

## MCP boundary

`adl mcp` is a local stdio MCP server. It exposes `delegate_task` and `get_task`; it does not host a network MCP endpoint or store invitation links. Codex or Claude starts it as a child process, then passes a link on each tool call.

## Audit boundary

The local JSONL log stores no task or patch plaintext. Each record includes the previous record hash. This provides a locally verifiable integrity chain, not signer identity or protection against an attacker who can rewrite and rehash the entire log.
