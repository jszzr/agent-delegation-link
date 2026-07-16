#!/usr/bin/env node
import path from "node:path";
import { Command, Option } from "commander";
import { createAdapter } from "./adapters.js";
import { parseDuration } from "./capability.js";
import { DelegationGateway, normalizePermissions } from "./gateway.js";
import { submitTask, waitForTask } from "./invoke.js";
import { agentKindSchema, type StoredTask } from "./protocol.js";
import { RelayServer } from "./relay.js";

const program = new Command()
  .name("adl")
  .description("Task-scoped delegation links for Codex and Claude Code")
  .version("0.1.0");

program
  .command("relay")
  .description("Start the rendezvous relay")
  .option("--host <host>", "listen host", "127.0.0.1")
  .option("--port <port>", "listen port", "8787")
  .option("--public-base-url <url>", "public URL embedded in invitation links")
  .action(async (options: { host: string; port: string; publicBaseUrl?: string }) => {
    const relay = new RelayServer();
    const address = await relay.start({
      host: options.host,
      port: Number(options.port),
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
  .command("share")
  .description("Share a task-scoped capability to a local coding agent")
  .requiredOption("--agent <agent>", "codex, claude, or fake")
  .option("--relay <url>", "relay origin", "http://127.0.0.1:8787")
  .option("--repo <path>", "Git repository delegated to the agent", process.cwd())
  .option("--permissions <list>", "comma-separated permissions", "read,edit")
  .option("--ttl <duration>", "link lifetime", "30m")
  .option("--max-tasks <count>", "maximum accepted tasks", "1")
  .option("--label <label>", "human-readable grant label", "delegated-agent")
  .option("--validate <command>", "owner-defined validation command; repeatable", collect, [])
  .action(async (options: {
    agent: string;
    relay: string;
    repo: string;
    permissions: string;
    ttl: string;
    maxTasks: string;
    label: string;
    validate: string[];
  }) => {
    const agent = agentKindSchema.parse(options.agent);
    const permissions = normalizePermissions([options.permissions]);
    const gateway = new DelegationGateway({
      relayOrigin: options.relay,
      repoPath: path.resolve(options.repo),
      adapter: createAdapter(agent),
      validationCommands: options.validate,
      policy: {
        label: options.label,
        agent,
        permissions,
        expiresAt: new Date(Date.now() + parseDuration(options.ttl)).toISOString(),
        maxTasks: Number(options.maxTasks),
        approval: "auto_within_scope"
      },
      onLog: (message) => console.error(`[gateway] ${message}`)
    });
    const { invitationUrl } = await gateway.start();
    console.log("Delegation link (treat as a secret):");
    console.log(invitationUrl);
    console.log("Gateway is waiting for delegated tasks. Press Ctrl-C to revoke and stop.");
    const shutdown = async () => {
      await gateway.stop();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  });

program
  .command("invoke")
  .description("Delegate a task through an invitation link")
  .argument("<invitation-url>")
  .requiredOption("--goal <goal>", "task goal")
  .option("--sender <name>", "sender identity", "remote-agent")
  .option("--permissions <list>", "requested permissions", "read,edit")
  .option("--constraint <text>", "constraint; repeatable", collect, [])
  .option("--acceptance <text>", "acceptance criterion; repeatable", collect, [])
  .addOption(new Option("--timeout <duration>", "wait timeout").default("10m"))
  .action(async (invitationUrl: string, options: {
    goal: string;
    sender: string;
    permissions: string;
    constraint: string[];
    acceptance: string[];
    timeout: string;
  }) => {
    const requestedPermissions = normalizePermissions([options.permissions]);
    const { taskId } = await submitTask(invitationUrl, {
      goal: options.goal,
      sender: options.sender,
      requestedPermissions,
      constraints: options.constraint,
      acceptanceCriteria: options.acceptance
    });
    console.error(`Task accepted: ${taskId}`);
    const task = await waitForTask(invitationUrl, taskId, {
      timeoutMs: parseDuration(options.timeout),
      onProgress: (message) => console.error(`[progress] ${message}`)
    });
    printTask(task);
    if (task.status === "failed") process.exitCode = 1;
  });

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function printTask(task: StoredTask): void {
  if (task.status === "failed") {
    console.error(`Task failed: ${task.error ?? "unknown error"}`);
    return;
  }
  console.log(JSON.stringify(task.result, null, 2));
}

await program.parseAsync(process.argv);
