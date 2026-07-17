# Agent Delegation Link

Agent Delegation Link (`adl`) lets one user's Codex or Claude Code send a scoped coding task to another user's local agent through one revocable URL. Both users make outbound connections, so they can be on different networks and behind NAT.

The project is now a **trusted-collaborator alpha**. It is ready for controlled tests with people you know, on non-sensitive repositories. It is not yet a safe boundary for anonymous users or hostile codebases; read [SECURITY.md](SECURITY.md) first.

## The core difference

Most multi-agent tools coordinate agents owned by one user, in one process or shared workspace. ADL treats the other person's agent as a remote, task-scoped capability:

```text
sender Codex/Claude -> ADL CLI or MCP -> HTTPS relay <- owner gateway -> owner Codex/Claude
```

- one link connects users across networks;
- the owner chooses repository, agent, permissions, expiry, task count, time limit, and validation commands;
- the relay routes end-to-end encrypted envelopes and cannot read the goal, progress, result, or patch;
- every task runs in a disposable Git worktree, and the result is a patch rather than a direct edit to the owner's checkout;
- owner approval is required by default.

## Alpha features

- Codex CLI, Claude Code, and deterministic fake adapters
- MCP tools: `delegate_task` and `get_task`
- AES-256-GCM end-to-end encryption with HKDF-separated relay and content keys
- expiring, revocable, task-counted capability links
- per-task approval, permission checks at relay and gateway, and owner-defined validation
- execution timeout, output/patch limits, request rate limiting, and optional relay registration token
- reconnect, encrypted offline queueing, and idempotent retry protection
- hash-chained local JSONL audit log without task or patch plaintext
- Docker/Caddy HTTPS relay deployment and CI

## Install from source

Requirements: Node.js 22+, Git, and an authenticated Codex or Claude Code CLI on the repository owner's machine.

```bash
npm ci
npm run check
npm test
npm run build
npm pack
npm install -g ./agent-delegation-link-0.2.0-alpha.1.tgz
```

## Local smoke test

Terminal 1:

```bash
adl relay
```

Terminal 2:

```bash
adl share \
  --agent fake \
  --repo . \
  --permissions read,edit,test \
  --approval auto_within_scope \
  --validate "npm test"
```

Terminal 3, after saving the printed full URL to a mode-600 file:

```bash
adl invoke --link-file /tmp/adl-link \
  --goal "Create a delegated-result file" \
  --permissions read,edit,test \
  --patch-file /tmp/delegated.patch
```

`auto_within_scope` is explicit in this deterministic local demo. Omit it for real collaboration; `ask_every_time` is the default.

## Agent-native use through MCP

Install the stdio MCP server once:

```bash
codex mcp add adl -- adl mcp
claude mcp add --scope user adl -- adl mcp
```

The sender's agent can then call `delegate_task` with an invitation URL, goal, requested permissions, constraints, and acceptance criteria. The full URL is a bearer secret and becomes visible to the sender's agent when used this way.

## Real two-user test

Follow [docs/ALPHA_TEST.md](docs/ALPHA_TEST.md). It covers an HTTPS relay, operator registration token, owner approval, secure link handling, Codex/Claude combinations, patch review, audit verification, and teardown.

## Development

```bash
npm run check
npm test
npm run build
npm run demo
docker build -t adl-relay .
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for protocol details and [SECURITY.md](SECURITY.md) for the threat model and remaining limitations.

## License

MIT
