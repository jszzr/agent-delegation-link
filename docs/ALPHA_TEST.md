# Two-user alpha test

This runbook gets one repository owner and one remote collaborator through a real Codex/Claude task. Use a small, non-sensitive test repository and people you trust.

## 1. Deploy the relay

On a VPS with Docker, public ports 80/443, and a DNS record such as `adl.example.com` pointing to it:

```bash
git clone <private-repository-url> agent-delegation-link
cd agent-delegation-link/examples/deploy
export ADL_DOMAIN=adl.example.com
export ADL_RELAY_REGISTRATION_TOKEN="$(openssl rand -base64 32)"
docker compose up -d --build
curl --fail "https://${ADL_DOMAIN}/health"
```

Keep `ADL_RELAY_REGISTRATION_TOKEN` in a password manager. Give it only to people who need to run `adl share`; task senders do not need it. The relay container is not published directly—Caddy terminates TLS and obtains its certificate automatically.

The relay is in-memory. Do not restart it during a test, or existing links/tasks will disappear.

## 2. Install ADL on both machines

From a private alpha release asset or a source checkout:

```bash
npm install -g ./agent-delegation-link-0.2.0-alpha.2.tgz
adl --version
```

Expected version: `0.2.0-alpha.2`.

For agent-native sending, configure one or both clients:

```bash
codex mcp add adl -- adl mcp
claude mcp add --scope user adl -- adl mcp
```

## 3. Owner shares a repository

The owner should start with a newly cloned, non-sensitive repository and a low-risk task. Set the relay registration token without placing it in command history:

```bash
read -s ADL_RELAY_TOKEN
export ADL_RELAY_TOKEN
adl share \
  --agent codex \
  --repo /absolute/path/to/test-repo \
  --relay https://adl.example.com \
  --relay-token-env ADL_RELAY_TOKEN \
  --permissions read,edit,test \
  --ttl 30m \
  --max-tasks 1 \
  --task-timeout 10m \
  --max-artifact-mb 2 \
  --approval ask_every_time \
  --validate "npm test"
```

Use `--agent claude` for Claude Code. Validation commands run locally and are owner-controlled; select commands appropriate to the repository. The command prints a full URL. Send it to the collaborator through an end-to-end encrypted channel.

## 4A. Collaborator invokes through the CLI

Save the received link without putting it in shell history:

```bash
umask 077
read -s ADL_LINK
printf '%s\n' "$ADL_LINK" > /tmp/adl-link
unset ADL_LINK

adl invoke \
  --link-file /tmp/adl-link \
  --goal "Add a focused unit test for the parser's empty-input case" \
  --sender "alice-codex" \
  --permissions read,edit,test \
  --constraint "Do not change public API behavior" \
  --acceptance "Existing and new tests pass" \
  --patch-file /tmp/adl-result.patch
```

## 4B. Collaborator invokes through Codex or Claude MCP

Ask the local agent to use the `delegate_task` tool and provide the invitation link, goal, permissions, constraints, and acceptance criteria. This is the intended direct agent-to-agent experience. The link will be present in that local agent's context, so do this only on a trusted machine and session.

## 5. Owner approves

The owner terminal displays sender, permissions, and decrypted goal, then asks:

```text
Approve this task? [y/N]
```

Verify the scope before entering `y`. Press Enter or type `n` to fail closed. ADL runs the approved task in a disposable worktree; the owner's checkout stays unchanged.

## 6. Review the result

The collaborator receives an encrypted result containing summary, changed paths, patch, and validation output. Review before applying:

```bash
git apply --stat /tmp/adl-result.patch
git apply --check /tmp/adl-result.patch
```

Apply it only after review. ADL deliberately does not apply, commit, push, or open a pull request automatically.

On the owner machine, verify the local audit chain:

```bash
cd /absolute/path/to/test-repo
adl audit verify .adl/audit.jsonl
git status --short
```

The audit should be valid, and the owner's checkout should have no delegated source changes. `.adl/audit.jsonl` is local and normally gitignored.

## 7. Teardown

The owner presses Ctrl-C. This revokes the link before the gateway exits. The collaborator deletes `/tmp/adl-link`; both users remove the URL from transient chat if their channel permits it.

Stop the relay after the test window if it is not continuously operated:

```bash
cd agent-delegation-link/examples/deploy
docker compose down
```

## Suggested test matrix

Run one small task for each pairing, creating a new one-task link each time:

| Sender | Owner agent | Expected path |
|---|---|---|
| Codex MCP | Codex | `delegate_task` -> approval -> encrypted patch |
| Claude MCP | Codex | same protocol, cross-vendor |
| Codex MCP | Claude | same protocol, cross-vendor |
| CLI | fake | deterministic infrastructure check without model quota |

Also verify three negative cases: deny an approval, request a permission outside the grant, and reuse an expired/revoked link. None should execute an agent.

## What to record

For alpha feedback, record only task IDs, agent pairing, timestamps, whether reconnect occurred, outcome, and sanitized error categories. Never copy invitation URLs, raw task text, private patches, CLI authentication files, or registration tokens into an issue.
