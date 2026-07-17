# Agent Delegation Link

Agent Delegation Link (`adl`) lets one user's Codex or Claude Code send a scoped coding task to another user's local agent through one revocable URL.

Both machines connect outward to an HTTPS/WSS Relay, so they can be on different networks and behind NAT: `sender agent -> encrypted Relay <- owner agent`.

> [!WARNING]
> This is a trusted-collaborator alpha for non-sensitive repositories. Read [SECURITY.md](SECURITY.md) before testing.

## Install

Requires Node.js 22+, Git, and an authenticated Codex or Claude Code CLI on the machine that executes tasks.

```bash
npm install -g https://github.com/jszzr/agent-delegation-link/releases/download/v0.2.0-alpha.2/agent-delegation-link-0.2.0-alpha.2.tgz
adl --version
```

## Two-machine quick start

Suppose user A sends a task to user B's agent. The Relay operator gives B the Relay URL and registration token; A does not need the token.

On B's machine, share a clean test repository:

```bash
read -s ADL_RELAY_TOKEN
export ADL_RELAY_TOKEN

adl share \
  --agent codex \
  --repo /absolute/path/to/test-repo \
  --relay https://relay.example.com \
  --relay-token-env ADL_RELAY_TOKEN \
  --permissions read,edit,test \
  --validate "npm test"
```

The defaults are a 30-minute, one-task link with explicit approval. Use `--agent claude` for Claude Code. Send the complete invitation URL to A through an end-to-end encrypted channel.

On A's machine, keep the link out of shell history and submit a task:

```bash
umask 077
read -s ADL_LINK
printf '%s\n' "$ADL_LINK" > /tmp/adl-link
unset ADL_LINK

adl invoke \
  --link-file /tmp/adl-link \
  --goal "Add a unit test for empty parser input" \
  --permissions read,edit,test \
  --patch-file /tmp/adl-result.patch
```

B reviews and approves the task. A receives the patch and validation output. Run `git apply --check` before applying it.

Links are directional and task-scoped. Reverse the roles and create a new link for B to send a task to A.

## Agent-to-agent use

Register ADL once, then let the sender's agent call the `delegate_task` MCP tool:

```bash
codex mcp add adl -- adl mcp
claude mcp add --scope user adl -- adl mcp
```

The invitation URL becomes visible to that local agent session, so use a trusted machine.

## Safety

- task content and patches are end-to-end encrypted; the Relay still sees routing metadata and traffic timing;
- the owner controls scope and approval; tasks run in temporary Git worktrees and return patches;
- links are bearer secrets, and no patch, failed validation, timeout, or out-of-scope permissions fail closed.

A worktree is not a complete OS sandbox. Linux owners must configure Codex's Bubblewrap/AppArmor sandbox and must not bypass failures with `danger-full-access`.

## More

- [Two-user runbook](docs/ALPHA_TEST.md)
- [Security model](SECURITY.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Latest prerelease](https://github.com/jszzr/agent-delegation-link/releases/tag/v0.2.0-alpha.2)

Development: `npm ci && npm run check && npm test && npm run build`

MIT licensed.
