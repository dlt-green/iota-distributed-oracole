// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

export function mustEnv(key: string): string {
  const v = process.env[key]?.trim();
  if (!v) throw new Error(`Missing env ${key}`);
  return v;
}

export function normalizeNetwork(raw: string | undefined | null): "devnet" | "testnet" | "mainnet" | "localnet" | "" {
  const net = String(raw ?? "").trim().toLowerCase();
  if (net === "dev" || net === "devnet") return "devnet";
  if (net === "local" || net === "localnet") return "localnet";
  if (net === "test" || net === "testnet") return "testnet";
  if (net === "main" || net === "mainnet") return "mainnet";
  return "";
}

export function networkPrefix(): "DEVNET" | "TESTNET" | "MAINNET" | "" {
  const net = normalizeNetwork(process.env.IOTA_NETWORK);
  if (net === "devnet" || net === "localnet") return "DEVNET";
  if (net === "testnet") return "TESTNET";
  if (net === "mainnet") return "MAINNET";
  return "";
}

export function envByNetwork(baseKey: string): string | undefined {
  const prefix = networkPrefix();
  if (prefix) {
    const v = process.env[`${prefix}_${baseKey}`]?.trim();
    if (v) return v;
  }
  const direct = process.env[baseKey]?.trim();
  if (direct) return direct;
  return undefined;
}

export function mustEnvByNetwork(baseKey: string, ...fallbackKeys: string[]): string {
  const candidateKeys = [baseKey, ...fallbackKeys];
  for (const key of candidateKeys) {
    const value = envByNetwork(key);
    if (value) return value;
  }
  throw new Error(`Missing env ${candidateKeys.join(" / ")}`);
}

export function getTasksPackageId(): string {
  return mustEnvByNetwork("ORACLE_TASKS_PACKAGE_ID", "ORACLE_PACKAGE_ID");
}

export function getSystemPackageId(): string {
  return mustEnvByNetwork("ORACLE_SYSTEM_PACKAGE_ID", "ORACLE_PACKAGE_ID");
}

export function getStateId(): string {
  return mustEnvByNetwork("ORACLE_STATE_ID", "ORACLE_STATUS_ID", "ORACLE_SYSTEM_STATE_ID");
}

export function getConfiguredNodeRegistryId(): string | undefined {
  return envByNetwork("ORACLE_NODE_REGISTRY_ID");
}

export function getTreasuryId(): string {
  return mustEnvByNetwork("ORACLE_TREASURY_ID", "ORACLE_TREASURY_OBJECT_ID");
}

export function getRandomId(): string {
  return (envByNetwork("IOTA_RANDOM_OBJECT_ID") || "0x8").trim() || "0x8";
}

export function getClockId(): string {
  return (envByNetwork("IOTA_CLOCK_OBJECT_ID") || envByNetwork("IOTA_CLOCK_ID") || "0x6").trim() || "0x6";
}

export function getIotaSystemStateId(): string {
  return (envByNetwork("IOTA_SYSTEM_STATE_ID") || "0x5").trim() || "0x5";
}

export function getTaskSchedulerQueueId(): string {
  return mustEnvByNetwork("ORACLE_TASK_SCHEDULER_QUEUE_ID");
}

export function getTaskRegistryId(): string {
  return mustEnvByNetwork("ORACLE_TASK_REGISTRY_ID");
}

export function defaultEventType(envKey: string, suffix: string): string {
  const v = process.env[envKey]?.trim();
  if (v) return v;
  const pkg = getTasksPackageId();
  return `${pkg}::${suffix}`;
}

export function parseNodeId(argv: string[]): string {
  const args = argv.slice(2);

  const pos = args.find((a) => a && !a.startsWith("-"));
  if (pos) return String(pos).trim();

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--node" && args[i + 1]) return String(args[i + 1]).trim();
    if (a.startsWith("--node=")) return a.slice("--node=".length).trim();
  }

  return (process.env.NODE_ID ?? "1").trim();
}
