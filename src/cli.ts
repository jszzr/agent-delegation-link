#!/usr/bin/env node
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stderr as output } from "node:process";
import { Command, Option } from "commander";
import { createAdapter } from "./adapters.js";
import { verifyAuditLog } from "./audit.js";
import { assertSecureRelayOrigin, parseDuration } from "./capability.js";
import {
  DEFAULT_RELAY_ORIGIN,
  getConfigPath,
  requireEnvironment,
  resolveRelaySettings,
  saveConfig
} from "./config.js";
import { DelegationGateway, normalizePermissions } from "./gateway.js";
import { submitTask, waitForTask } from "./invoke.js";
import { startMcpServer } from "./mcp.js";
import { agentKindSchema, type GrantPolicy, type StoredTask, type TaskRequest } from "./protocol.js";
import { RelayServer } from "./relay.js";
import type { ExecutionMode } from "./worktree.js";

const VERSION = "0.3.0-alpha.1";
const program = new Command()
  .name("adl")
  .description("Encrypted task-scoped delegation links for Codex and Claude Code")
  .version(VERSION);

interface QuickLinkOptions {
  agent: string;
  repo: string;
  relay?: string;
  mode: ExecutionMode;
  permissions: string;
  ttl: string;
  taskTimeout: string;
  label: string;
  auditFile: string;
  relayTokenEnv?: string;
  validate: string[];
}

interface ShareOptions extends QuickLinkOptions {
  maxTasks: string;
  maxArtifactMb: string;
  approval: "ask_every_time" | "auto_within_scope";
}

interface InvokeOptions {
  linkFile?: string;
  patchFile?: string;
  goal: string;
  sender: string;
  permissions: string;
  constraint: string[];
  acceptance: string[];
  timeout: string;
}

program
  .command("relay")
  .description("Start the rendezvous relay")
  .option("--host <host>", "listen host", "127.0.0.1")
  .option("--port <port>", "listen port", "8787")
  .option("--public-base-url <url>", "HTTPS public URL embedded in invitation links")
  .option("--rate-limit <count>", "maximum requests per source IP per minute", "120")
  .option("--trust-proxy", "trust X-Forwarded-For from a configured reverse proxy", false)
  .option("--registration-token-env <name>", "environment variable required for creating grants")
  .action(async (options: {
    host: string;
    port: string;
    publicBaseUrl?: string;
    rateLimit: string;
    trustProxy: boolean;
    registrationTokenEnv?: string;
  }) => {
    const loopback = options.host === "127.0.0.1" || options.host === "localhost" || options.host === "::1";
    if (!loopback && !options.publicBaseUrl) {
      throw new Error("--public-base-url https://... is required when listening beyond loopback");
    }
    const relay = new RelayServer();
    const registrationToken = options.registrationTokenEnv === undefined
      ? undefined
      : requireEnvironment(options.registrationTokenEnv);
    const address = await relay.start({
      host: options.host,
      port: Number(options.port),
      maxRequestsPerMinute: Number(options.rateLimit),
      trustProxy: options.trustProxy,
      ...(registrationToken === undefined ? {} : { registrationToken }),
      onLog: (message) => console.error(`[relay] ${message}`),
      ...(options.publicBaseUrl === undefined ? {} : { publicBaseUrl: options.publicBaseUrl })
    });
    console.log(`Relay listening at ${address.origin}`);
    const shutdown = async () => {
      await relay.stop();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  });

program
  .command("setup")
  .description("Save the Relay URL and registration token securely on this machine")
  .option("--relay <url>", "Relay origin", DEFAULT_RELAY_ORIGIN)
  .requiredOption("--token-env <name>", "environment variable containing the Relay registration token")
  .action(async (options: { relay: string; tokenEnv: string }) => {
    assertSecureRelayOrigin(options.relay);
    const configPath = getConfigPath();
    await saveConfig({
      relayOrigin: options.relay,
      relayRegistrationToken: requireEnvironment(options.tokenEnv)
    }, configPath);
    console.log(`ADL is configured for ${options.relay}`);
    console.log(`Credentials saved with owner-only permissions at ${configPath}`);
  });

program
  .command("link")
  .description("Create a one-task link using safe, useful defaults")
  .option("--agent <agent>", "codex or claude", "codex")
  .option("--repo <path>", "directory delegated to the agent", process.cwd())
  .option("--relay <url>", "override the configured Relay origin")
  .addOption(new Option("--mode <mode>", "direct edits or isolated worktree patch").choices(["direct", "worktree"]).default("direct"))
  .option("--permissions <list>", "comma-separated permissions", "read,edit")
  .option("--ttl <duration>", "link lifetime", "15m")
  .option("--task-timeout <duration>", "maximum task duration", "10m")
  .option("--label <label>", "human-readable grant label", "quick-link")
  .option("--audit-file <path>", "hash-chained audit log", ".adl/audit.jsonl")
  .option("--relay-token-env <name>", "override the saved token with an environment variable")
  .option("--validate <command>", "owner-defined validation command; repeatable", collect, [])
  .action(async (options: QuickLinkOptions) => {
    await startGateway({
      ...options,
      maxTasks: "1",
      maxArtifactMb: "2",
      approval: "ask_every_time"
    });
  });

program
  .command("share")
  .description("Share a task-scoped capability to a local coding agent")
  .requiredOption("--agent <agent>", "codex, claude, or fake")
  .option("--relay <url>", "override the configured Relay origin")
  .option("--repo <path>", "directory delegated to the agent", process.cwd())
  .addOption(new Option("--mode <mode>", "direct edits or isolated worktree patch").choices(["direct", "worktree"]).default("worktree"))
  .option("--permissions <list>", "comma-separated permissions", "read,edit")
  .option("--ttl <duration>", "link lifetime", "30m")
  .option("--max-tasks <count>", "maximum accepted tasks", "1")
  .option("--task-timeout <duration>", "maximum duration of each task", "10m")
  .option("--max-artifact-mb <count>", "maximum returned patch size in MiB", "2")
  .option("--label <label>", "human-readable grant label", "delegated-agent")
  .addOption(new Option("--approval <mode>", "owner approval policy").choices(["ask_every_time", "auto_within_scope"]).default("ask_every_time"))
  .option("--audit-file <path>", "hash-chained audit log", ".adl/audit.jsonl")
  .option("--relay-token-env <name>", "environment variable containing the relay registration token")
  .option("--validate <command>", "owner-defined validation command; repeatable", collect, [])
  .action(async (options: ShareOptions) => startGateway(options));

registerInvokeCommand("send", "Send a task through an invitation link");
registerInvokeCommand("invoke", "Delegate a task through an invitation link (advanced alias)");

program
  .command("mcp")
  .description("Run the ADL MCP server over stdio")
  .action(async () => startMcpServer());

const audit = program.command("audit").description("Inspect local security audit logs");
audit
  .command("verify")
  .argument("[file]", "audit JSONL file", ".adl/audit.jsonl")
  .action(async (file: string) => {
    const result = await verifyAuditLog(path.resolve(file));
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 1;
  });

async function startGateway(options: ShareOptions): Promise<void> {
  const agent = agentKindSchema.parse(options.agent);
  const permissions = normalizePermissions([options.permissions]);
  const repoPath = path.resolve(options.repo);
  const relay = await resolveRelaySettings({
    ...(options.relay === undefined ? {} : { relayOrigin: options.relay }),
    ...(options.relayTokenEnv === undefined ? {} : { relayTokenEnvironment: options.relayTokenEnv })
  });
  const policy: GrantPolicy = {
    label: options.label,
    agent,
    permissions,
    expiresAt: new Date(Date.now() + parseDuration(options.ttl)).toISOString(),
    maxTasks: Number(options.maxTasks),
    approval: options.approval,
    maxTaskDurationSeconds: Math.ceil(parseDuration(options.taskTimeout) / 1_000),
    maxArtifactBytes: Math.floor(Number(options.maxArtifactMb) * 1_048_576)
  };
  const gateway = new DelegationGateway({
    relayOrigin: relay.relayOrigin,
    repoPath,
    executionMode: options.mode,
    adapter: createAdapter(agent),
    validationCommands: options.validate,
    policy,
    auditFile: path.resolve(repoPath, options.auditFile),
    ...(relay.relayRegistrationToken === undefined
      ? {}
      : { relayRegistrationToken: relay.relayRegistrationToken }),
    ...(options.approval === "ask_every_time" ? { approveTask: promptForApproval } : {}),
    onLog: (message) => console.error(`[gateway] ${message}`)
  });
  const { invitationUrl } = await gateway.start();
  if (options.mode === "direct") {
    console.error("Direct mode: approved tasks modify the selected directory immediately; no Git HEAD or patch is required.");
  }
  console.log("Delegation link (treat the complete URL as a secret):");
  console.log(invitationUrl);
  console.log(`Mode: ${options.mode}. Approval: ${options.approval}. Ctrl-C revokes the link.`);
  const shutdown = async () => {
    await gateway.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

function registerInvokeCommand(name: string, description: string): void {
  program
    .command(name)
    .description(description)
    .argument("[invitation-url]")
    .option("--link-file <path>", "read the invitation URL from a local file to avoid shell history")
    .option("--patch-file <path>", "write a returned worktree patch without applying it")
    .requiredOption("--goal <goal>", "task goal")
    .option("--sender <name>", "sender identity", "remote-agent")
    .option("--permissions <list>", "requested permissions", "read,edit")
    .option("--constraint <text>", "constraint; repeatable", collect, [])
    .option("--acceptance <text>", "acceptance criterion; repeatable", collect, [])
    .addOption(new Option("--timeout <duration>", "wait timeout").default("10m"))
    .action(async (invitationUrl: string | undefined, options: InvokeOptions) => {
      const resolvedInvitationUrl = await resolveInvitationUrl(invitationUrl, options.linkFile);
      const requestedPermissions = normalizePermissions([options.permissions]);
      const submitted = await submitTask(resolvedInvitationUrl, {
        goal: options.goal,
        sender: options.sender,
        requestedPermissions,
        constraints: options.constraint,
        acceptanceCriteria: options.acceptance
      });
      console.error(`Task accepted: ${submitted.taskId}`);
      if (!submitted.gatewayOnline) console.error("Gateway is currently offline; the encrypted task is queued.");
      const task = await waitForTask(resolvedInvitationUrl, submitted.taskId, {
        timeoutMs: parseDuration(options.timeout),
        onProgress: (message) => console.error(`[progress] ${message}`)
      });
      printTask(task);
      if (options.patchFile && task.result?.patch) {
        const patchFile = path.resolve(options.patchFile);
        await writeFile(patchFile, task.result.patch, { encoding: "utf8", mode: 0o600 });
        console.error(`Patch written to ${patchFile}; review it before running git apply.`);
      } else if (options.patchFile && task.result?.executionMode === "direct") {
        console.error("No patch was written because direct mode changed the owner's directory in place.");
      }
      if (task.status === "failed") process.exitCode = 1;
    });
}

async function promptForApproval(task: TaskRequest, context: { taskId: string; policy: GrantPolicy }): Promise<boolean> {
  console.error("\nIncoming delegated task");
  console.error(`Task: ${context.taskId}`);
  console.error(`Sender: ${task.sender}`);
  console.error(`Permissions: ${task.requestedPermissions.join(", ")}`);
  console.error(`Goal:\n${task.goal}`);
  if (!input.isTTY) {
    console.error("Denied because interactive approval requires a TTY. Use --approval auto_within_scope only for trusted automation.");
    return false;
  }
  const terminal = createInterface({ input, output });
  try {
    const answer = await terminal.question("Approve this task? [y/N] ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    terminal.close();
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function resolveInvitationUrl(argument: string | undefined, linkFile: string | undefined): Promise<string> {
  if ((argument === undefined) === (linkFile === undefined)) {
    throw new Error("Provide exactly one invitation URL argument or --link-file <path>");
  }
  return argument ?? (await readFile(path.resolve(linkFile!), "utf8")).trim();
}

function printTask(task: StoredTask): void {
  if (task.status === "failed") {
    console.error(`Task failed: ${task.error ?? "unknown error"}`);
    return;
  }
  console.log(JSON.stringify(task.result, null, 2));
}

await program.parseAsync(process.argv);
