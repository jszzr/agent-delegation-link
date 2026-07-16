# Architecture

## Core abstraction

An invitation URL is a task-scoped capability to invoke one local coding agent. It is not a room membership token.

```text
Sender Agent -> invoke CLI -> Relay <- WebSocket <- Owner Gateway -> Policy -> Codex/Claude
```

Both users make outbound connections, so the design works across NAT and different networks without inbound ports. In v0.1 the relay is run locally; a hosted or self-hosted relay can use the same protocol later.

## Grant lifecycle

1. The owner gateway generates a random grant ID and 256-bit secret.
2. It sends the secret digest and public policy to the relay.
3. The secret is placed in the invitation URL fragment, which browsers do not send in HTTP requests.
4. The gateway authenticates its WebSocket with a distinct owner token.
5. An invoker submits a structured task using the invitation secret.
6. The relay and gateway independently enforce the capability policy.
7. Stopping the gateway revokes the grant.

## Task lifecycle

```text
queued -> running -> completed
                  -> failed
```

The relay queues accepted tasks until the gateway is online. A gateway processes one task at a time and streams bounded progress messages.

## Execution boundary

Every task receives a detached temporary worktree at the repository's current `HEAD`. Uncommitted owner changes are intentionally excluded. After the agent exits:

1. owner-configured validation commands run;
2. `git diff --binary HEAD` captures the artifact;
3. `git status --short` captures changed paths;
4. the result is returned to the invoker;
5. the temporary worktree is destroyed.

`test` permission does not let the remote sender provide shell commands. It only enables validation commands chosen by the owner when the link is created.

## Adapter contract

Adapters implement a single operation:

```ts
execute({ task, cwd, permissions, onProgress })
```

Codex uses `codex exec --json` with an ephemeral session and the built-in sandbox. Claude uses print-mode stream JSON, safe mode, no session persistence, and an explicit tool set. The fake adapter makes integration tests deterministic and free of model usage.

## Planned protocol evolution

- MCP server for ergonomic invocation from Codex and Claude Code
- end-to-end encrypted envelopes
- signed agent identity and provenance
- human approval callbacks
- resumable task delivery
- artifact upload separate from the message channel
- optional A2A compatibility at the task envelope boundary
