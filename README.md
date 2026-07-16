# Agent Delegation Link

Share a task-scoped agent capability, not a workspace.

Agent Delegation Link (`adl`) lets one user's Codex or Claude Code delegate work to another user's local coding agent through a revocable URL. The owner chooses the repository, permissions, expiry, task count, and validation commands. The receiving gateway runs the task in a disposable Git worktree and returns a patch instead of modifying the owner's checkout.

This repository contains the local-first v0.1 prototype. It is suitable for development and localhost testing, not public deployment yet. See [SECURITY.md](SECURITY.md).

## What works in v0.1

- In-memory HTTP/WebSocket relay
- Bearer capability stored in the invitation URL fragment
- Expiry, maximum-task, revocation, and permission enforcement
- Local gateway that wakes a configured agent when a task arrives
- Codex CLI, Claude Code, and deterministic fake adapters
- Disposable Git worktree per task
- Owner-defined validation commands
- Structured result containing summary, patch, changed files, and validation logs
- Unit, policy, and end-to-end tests that do not consume model quota

## Quick start

Requirements: Node.js 22+, Git, and optionally authenticated Codex/Claude Code CLIs.

```bash
npm install
npm test
npm run demo
```

### Three-terminal manual test

Terminal 1 — start the local relay:

```bash
npm run dev -- relay
```

Terminal 2 — share a deterministic fake agent against this repository:

```bash
npm run dev -- share \
  --agent fake \
  --repo . \
  --permissions read,edit,test \
  --validate "npm test"
```

Copy the printed invitation URL.

Terminal 3 — invoke it:

```bash
npm run dev -- invoke 'PASTE_THE_FULL_LINK_HERE' \
  --goal "Add a short delegated-result file" \
  --permissions read,edit,test \
  --acceptance "Return a Git patch"
```

The original checkout remains unchanged. The invoker receives the patch generated in a temporary worktree.

## Real Codex and Claude adapters

Replace `--agent fake` with `codex` or `claude`. These commands use the locally authenticated CLI and may consume subscription quota:

```bash
npm run dev -- share --agent codex --repo /path/to/repo --permissions read,edit
npm run dev -- share --agent claude --repo /path/to/repo --permissions read,edit
```

The sender can be another coding agent: both Codex and Claude Code can execute the `adl invoke` command as a normal shell tool. A dedicated MCP wrapper is planned after the delegation and safety model is validated.

## Design principles

1. The link grants a narrow capability, not membership in a shared workspace.
2. Policy checks happen in the relay and local gateway, outside the language model.
3. Remote task text is always untrusted input.
4. The owner's real checkout is never directly edited.
5. Publishing, pushing, credential access, and arbitrary remote commands are out of scope.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the protocol and component boundaries.

## Development

```bash
npm run check
npm run build
npm test
```

## License

MIT
