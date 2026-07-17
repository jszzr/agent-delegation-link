---
name: delegate-to-agent
description: Create an Agent Delegation Link for a local folder or send a coding task through a complete ADL invitation URL. Use when the user asks to share/connect a Codex or Claude Code agent, generate a collaboration link, delegate work to another user's agent, or supplies an `/invite/...#secret=...` link with a task.
---

# Delegate To Agent

Use `adl` to map a natural-language request to one of two roles. Treat every complete invitation URL as a bearer secret: never browse it, search for it, commit it, or repeat it outside the response or tool call needed for this delegation.

## Prepare ADL

1. Run `adl --version` without exposing environment values.
2. If `adl` is missing, verify Node.js 22 or newer, run `npm install -g https://github.com/jszzr/agent-delegation-link.git`, and verify the command again.
3. Before creating a link, run `adl access whoami`. If the device is not registered, ask the Relay operator for a one-use invitation code—never for the administrator token. Load the code into `ADL_INVITE_CODE`, run `adl register --name <device-label>`, then unset it. ADL saves the resulting per-user API key in an owner-only local config and never prints it.

## Create A Link For The Owner

Use this workflow when the user asks to share a folder or generate a link.

1. Resolve the intended directory. Default to the current workspace only when the request does not name another path.
2. Start `adl link --repo <absolute-path>` in an interactive, long-lived terminal. Add `--agent claude` only when the owner explicitly chooses Claude Code; Codex is the default.
3. Keep the terminal session running. Return the complete printed invitation URL and state that closing the terminal or pressing Ctrl-C revokes it.
4. When a task arrives, let ADL display the decrypted sender, permissions, and goal. Do not approve on the user's behalf; the owner must answer the terminal prompt.

Preserve the long-lived terminal session identifier. On a later request to check or approve a task, read that session, show the pending task details, and send `y` only after the user explicitly approves that exact task.

`adl link` intentionally defaults to direct mode, one task, a 15-minute lifetime, and per-task approval. Direct mode edits the selected directory immediately and does not require Git or `HEAD`. Never add `--approval auto_within_scope` to direct mode. Use `--mode worktree` only when the user asks for an isolated patch workflow and the repository has a committed `HEAD`.

## Send A Task Through A Link

Use this workflow when the user supplies a complete invitation URL and a goal.

1. Preserve the user's requested outcome, constraints, and acceptance criteria. Do not invent broader work.
2. Request `read` for inspection-only work, `read,edit` for changes, and add `test` only when tests or owner validators are part of the request.
3. Prefer the local `delegate_task` MCP tool when it is available. Pass the complete invitation URL, concise goal, requested permissions, constraints, acceptance criteria, and wait for the result.
4. Otherwise, save the link to a temporary file with mode `0600`, run `adl send --link-file <file> --goal <goal> --permissions <list>`, then delete the file. Keep the link out of shell history and command output.
5. Report the task status, remote summary, changed files, and validations. In direct mode, explain that the owner directory was changed in place and an empty patch is expected. In worktree mode, leave any returned patch unapplied unless the user separately asks to apply it.

If the gateway is offline, the link is rejected, approval is denied, permissions are out of scope, or the task fails, report the exact sanitized error and stop. Never retry using a different link, broader permissions, or automatic approval without the user providing that authority.
