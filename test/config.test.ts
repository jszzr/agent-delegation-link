import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RELAY_ORIGIN, loadConfig, resolveRelaySettings, saveConfig } from "../src/config.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("local Relay configuration", () => {
  it("stores a per-user API key in an owner-only file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "adl-config-user-"));
    cleanup.push(directory);
    const file = path.join(directory, "config.json");
    const apiKey = `adl_usr_${"a".repeat(43)}`;
    await saveConfig({ relayOrigin: DEFAULT_RELAY_ORIGIN, relayApiKey: apiKey }, file);
    expect(await loadConfig(file)).toEqual({ relayOrigin: DEFAULT_RELAY_ORIGIN, relayApiKey: apiKey });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("stores the registration token in an owner-only file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "adl-config-"));
    cleanup.push(directory);
    const file = path.join(directory, "nested", "config.json");
    await saveConfig({ relayOrigin: DEFAULT_RELAY_ORIGIN, relayRegistrationToken: "operator-secret" }, file);
    expect(await loadConfig(file)).toEqual({
      relayOrigin: DEFAULT_RELAY_ORIGIN,
      relayRegistrationToken: "operator-secret"
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveProperty("relayRegistrationToken", "operator-secret");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("rejects a config file readable by other local users", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(path.join(os.tmpdir(), "adl-config-loose-"));
    cleanup.push(directory);
    const file = path.join(directory, "config.json");
    await saveConfig({ relayOrigin: DEFAULT_RELAY_ORIGIN }, file);
    await chmod(file, 0o644);
    await expect(loadConfig(file)).rejects.toThrow("permissions are too broad");
  });

  it("uses explicit environment values before saved defaults", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "adl-config-resolution-"));
    cleanup.push(directory);
    const file = path.join(directory, "config.json");
    await saveConfig({ relayOrigin: "https://saved.example", relayRegistrationToken: "saved-token" }, file);
    await expect(resolveRelaySettings({
      configPath: file,
      relayTokenEnvironment: "OVERRIDE_TOKEN",
      environment: { ADL_RELAY_URL: "https://environment.example", OVERRIDE_TOKEN: "environment-token" }
    })).resolves.toEqual({
      relayOrigin: "https://environment.example",
      relayRegistrationToken: "environment-token"
    });
  });

  it("never sends a saved token to a different Relay origin", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "adl-config-origin-"));
    cleanup.push(directory);
    const file = path.join(directory, "config.json");
    await saveConfig({
      relayOrigin: "https://saved.example",
      relayApiKey: `adl_usr_${"b".repeat(43)}`,
      relayRegistrationToken: "saved-token"
    }, file);
    await expect(resolveRelaySettings({
      configPath: file,
      relayOrigin: "https://other.example",
      environment: {}
    })).resolves.toEqual({ relayOrigin: "https://other.example" });
  });
});
