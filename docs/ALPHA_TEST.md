# Two-user alpha test

Use two trusted users, two machines, and a non-sensitive test directory. The default Relay is `https://47.94.129.192`; both clients connect outward, so no shared LAN or inbound port is required.

## 1. Install

On both machines:

```bash
npm install -g https://github.com/jszzr/agent-delegation-link.git
adl --version
```

Expected version: `0.3.0-alpha.1`.

Install the `delegate-to-agent` Skill from `.agents/skills/delegate-to-agent` with Codex's `$skill-installer`. Optionally register the sender MCP tool:

```bash
codex mcp add adl -- adl mcp
```

The owner machine must also have an authenticated Codex or Claude Code CLI. Linux Codex owners must verify its Bubblewrap/AppArmor sandbox with `codex doctor`; do not bypass sandbox failures with `danger-full-access`.

## 2. Configure the owner once

The Relay operator privately gives the owner the registration token. A sender does not need it.

```bash
read -s ADL_RELAY_TOKEN
export ADL_RELAY_TOKEN
adl setup --token-env ADL_RELAY_TOKEN
unset ADL_RELAY_TOKEN
```

Verify that ADL reports the expected Relay and an owner-only config path without printing the token.

## 3. Owner creates a link

From a new test directory, ask Codex “用 ADL 把当前目录分享给朋友的 Codex”, or run:

```bash
adl link --repo "$PWD"
```

Keep this process running. It defaults to Codex, direct edits, one task, a 15-minute lifetime, and explicit approval. No Git repository or commit is required. Use `--agent claude` for Claude Code or `--mode worktree` for a patch-only test in a repository with committed `HEAD`.

Send the complete invitation URL through a private end-to-end encrypted channel.

## 4. Collaborator sends a task

Give the installed Skill a single prompt containing both the goal and complete link, for example:

```text
用这个 ADL 链接让对方 agent 创建 README.md，内容是“hello, Dunjun Li”：<complete invitation URL>
```

CLI fallback:

```bash
umask 077
read -s ADL_LINK
printf '%s\n' "$ADL_LINK" > /tmp/adl-link
unset ADL_LINK
adl send --link-file /tmp/adl-link --goal 'Create README.md containing exactly: hello, Dunjun Li' --permissions read,edit
rm -f /tmp/adl-link
```

## 5. Owner approves and verifies

The owner terminal displays sender, requested permissions, and the decrypted goal. Verify them, then enter `y`. Do not approve a broader or unexpected task.

For direct mode, confirm `README.md` appeared in the owner's selected directory and the sender received `executionMode: direct`, an empty patch, and `README.md` in `changedFiles`. A validation failure or agent error can still leave direct changes behind, so always inspect the directory.

For worktree mode, confirm the owner checkout stayed unchanged and the sender received a non-empty patch. Review it with `git apply --stat` and `git apply --check` before any separate apply operation.

Verify the local audit chain:

```bash
adl audit verify .adl/audit.jsonl
```

## 6. Negative checks

Create a fresh one-task link for each check:

- deny owner approval and verify the agent does not start;
- request a permission not present in the grant and verify rejection;
- stop the owner gateway and verify the link is revoked;
- reuse a consumed link and verify the one-task limit.

Record only task IDs, timestamps, agent pairing, result, and sanitized errors. Never copy invitation URLs, registration tokens, private task text, or patches into a public issue.
