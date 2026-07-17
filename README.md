# Agent Delegation Link

Agent Delegation Link (`adl`) lets one user's Codex or Claude Code send a scoped task to another user's local coding agent through one secret link. Both machines connect outward to an encrypted Relay, so they can be on different networks and behind NAT.

> [!WARNING]
> This is a trusted-collaborator alpha. Use a non-sensitive test directory and read [SECURITY.md](SECURITY.md).

## Install

Requires Node.js 22+ and an authenticated Codex or Claude Code CLI on the machine that executes tasks.

```bash
npm install -g https://github.com/jszzr/agent-delegation-link.git
adl --version
```

Install the Codex Skill by asking Codex:

```text
Use $skill-installer to install delegate-to-agent from https://github.com/jszzr/agent-delegation-link/tree/main/.agents/skills/delegate-to-agent
```

## Owner: one-time setup

The public default Relay is `https://47.94.129.192`. Its registration token is deliberately not stored in this public repository. The Relay operator gives it only to people allowed to create links.

```bash
read -s ADL_RELAY_TOKEN
export ADL_RELAY_TOKEN
adl setup --token-env ADL_RELAY_TOKEN
unset ADL_RELAY_TOKEN
```

The token is saved locally with owner-only permissions. A task sender does not need this token.

## Create a link

Ask Codex:

```text
用 ADL 把当前目录分享给朋友的 Codex
```

The Skill starts the equivalent of:

```bash
adl link --repo "$PWD"
```

It prints a one-task, 15-minute link. Send the complete URL through a private channel and keep the owner gateway running. When a task arrives, the owner sees its sender, permissions, and goal and must approve it explicitly.

`adl link` uses `direct` mode by default: no Git repository or `HEAD` is required, changes go straight into the selected directory, and no patch is returned. To keep the original checkout unchanged and receive a patch instead, use `adl link --mode worktree`; that mode requires a committed Git `HEAD`.

Use `--agent claude` when the receiving machine should execute with Claude Code.

## Send a task

After installing the same Skill, the collaborator can give their Codex the link and task in one message:

```text
用这个 ADL 链接让对方 agent 创建 README.md，内容是“hello, Dunjun Li”：<complete invitation URL>
```

The Skill prefers ADL's `delegate_task` MCP tool when configured and otherwise uses `adl send`. Optional agent-native setup:

```bash
codex mcp add adl -- adl mcp
claude mcp add --scope user adl -- adl mcp
```

## Security defaults

- task text and results are encrypted end to end; the Relay sees routing metadata and traffic timing;
- the complete invitation URL is a bearer secret—do not post it publicly, open it in web tools, or save it in shell history;
- direct mode always requires per-task owner approval and reports changed paths, but cannot roll back a failed task;
- worktree mode preserves the owner checkout and returns a reviewable patch;
- stopping the owner gateway revokes the link.

More: [test runbook](docs/ALPHA_TEST.md), [security model](SECURITY.md), [architecture](docs/ARCHITECTURE.md).

Development: `npm ci && npm run check && npm test && npm run build`

MIT licensed.
