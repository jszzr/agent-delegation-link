import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_RELAY_ORIGIN = "https://47.94.129.192";

export interface AdlConfig {
  relayOrigin: string;
  relayApiKey?: string;
  relayRegistrationToken?: string;
}

export function getConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.ADL_CONFIG_FILE) return path.resolve(environment.ADL_CONFIG_FILE);
  const base = environment.XDG_CONFIG_HOME
    ? path.resolve(environment.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(base, "adl", "config.json");
}

export async function loadConfig(configPath = getConfigPath()): Promise<AdlConfig | undefined> {
  let details;
  try {
    details = await lstat(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`ADL config must be a regular file, not a symlink: ${configPath}`);
  }
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new Error(`ADL config permissions are too broad; run: chmod 600 ${configPath}`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to read ADL config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error(`ADL config must contain a JSON object: ${configPath}`);
  }
  const record = decoded as Record<string, unknown>;
  if (typeof record.relayOrigin !== "string" || record.relayOrigin.trim() === "") {
    throw new Error(`ADL config is missing relayOrigin: ${configPath}`);
  }
  if (record.relayRegistrationToken !== undefined
      && (typeof record.relayRegistrationToken !== "string" || record.relayRegistrationToken.trim() === "")) {
    throw new Error(`ADL config contains an invalid relayRegistrationToken: ${configPath}`);
  }
  if (record.relayApiKey !== undefined
      && (typeof record.relayApiKey !== "string" || !/^adl_usr_[A-Za-z0-9_-]{43}$/.test(record.relayApiKey))) {
    throw new Error(`ADL config contains an invalid relayApiKey: ${configPath}`);
  }
  return {
    relayOrigin: record.relayOrigin,
    ...(typeof record.relayApiKey === "string" ? { relayApiKey: record.relayApiKey } : {}),
    ...(typeof record.relayRegistrationToken === "string"
      ? { relayRegistrationToken: record.relayRegistrationToken }
      : {})
  };
}

export async function saveConfig(config: AdlConfig, configPath = getConfigPath()): Promise<void> {
  const directory = path.dirname(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, configPath);
    if (process.platform !== "win32") await chmod(configPath, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function resolveRelaySettings(options: {
  relayOrigin?: string;
  relayApiKeyEnvironment?: string;
  relayTokenEnvironment?: string;
  environment?: NodeJS.ProcessEnv;
  configPath?: string;
} = {}): Promise<AdlConfig> {
  const environment = options.environment ?? process.env;
  const config = await loadConfig(options.configPath ?? getConfigPath(environment));
  const relayOrigin = options.relayOrigin
    ?? environment.ADL_RELAY_URL
    ?? config?.relayOrigin
    ?? DEFAULT_RELAY_ORIGIN;
  const savedCredentialMatchesRelay = config !== undefined && sameOrigin(relayOrigin, config.relayOrigin);
  const relayApiKey = options.relayApiKeyEnvironment === undefined
    ? environment.ADL_RELAY_API_KEY
      ?? (savedCredentialMatchesRelay ? config?.relayApiKey : undefined)
    : requireEnvironment(options.relayApiKeyEnvironment, environment);
  const relayRegistrationToken = options.relayTokenEnvironment === undefined
    ? environment.ADL_RELAY_REGISTRATION_TOKEN
      ?? (savedCredentialMatchesRelay ? config?.relayRegistrationToken : undefined)
    : requireEnvironment(options.relayTokenEnvironment, environment);
  return {
    relayOrigin,
    ...(relayApiKey === undefined ? {} : { relayApiKey }),
    ...(relayRegistrationToken === undefined ? {} : { relayRegistrationToken })
  };
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function requireEnvironment(name: string, environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment[name];
  if (!value) throw new Error(`Environment variable ${name} is required and must not be empty`);
  return value;
}
