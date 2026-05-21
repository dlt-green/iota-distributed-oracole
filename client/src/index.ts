import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Transaction, coinWithBalance } from "@iota/iota-sdk/transactions";

import { iotaClient } from "./iota";
import { loadOrCreateClientIdentity } from "./keys";
import { requestFaucetIfEnabled } from "./faucet";
import { bcsU64, bcsU8, bcsVecU8, utf8ToBytes } from "./bcs";
import { bytesToUtf8, decodeVecU8 } from "./events";
import { signAndExecuteWithLockRetry } from "./txRetry.js";

type AnyClient = ReturnType<typeof iotaClient> & Record<string, any>;

type TaskTemplateInfo = {
  templateId: number;
  taskType: string;
  isEnabled: number;
  basePriceIota: bigint;
  schedulerFeeIota: bigint;
  maxInputBytes: bigint;
  maxOutputBytes: bigint;
  includedDownloadBytes: bigint;
  pricePerDownloadByteIota: bigint;
  allowStorage: number;
  minRetentionDays: bigint;
  maxRetentionDays: bigint;
  pricePerRetentionDayIota: bigint;
};

type StateEconomics = {
  systemFeeBps: bigint;
  minPayment: bigint;
};

type PreparedTask = {
  templateId: number;
  taskType: string;
  payloadJson: any;
  payloadText: string;
  requestedNodes: number;
  quorumK: number;
  mediationMode: number;
  varianceMax: number;
  retentionDays: number;
  declaredDownloadBytes: bigint;
  createResultControllerCap: number;
  storageSourceUrl?: string;
};

type CreateTaskContext = {
  tasksPkg: string;
  registryId: string;
  stateId: string;
  nodeRegistryId: string;
  iotaSystemStateId: string;
  treasuryId: string;
  randomId: string;
  clockId: string;
  prepared: PreparedTask;
  requiredPayment: bigint;
  requiredPerRun: bigint;
  gasBudget: bigint;
  fundingSource: "gas" | "dedicated";
};

type ScheduleInput = {
  startScheduleMs: bigint;
  endScheduleMs: bigint;
  intervalMs: bigint;
  initialFunds: bigint;
};

type PreparedWalletTransaction = {
  ok: true;
  mode: "prepare-webview";
  sender: string;
  variant: string;
  serializedTransaction: string;
  gasBudget: string;
  requiredPayment: string;
  requiredPerRun: string;
  rawPrice: string;
  systemFee: string;
  totalPrice: string;
  downloadPrice: string;
  extraDownloadBytes: string;
  balance: string;
  treasuryBalanceBefore: string | null;
  template: {
    templateId: number;
    taskType: string;
  };
  prepared: {
    templateId: number;
    taskType: string;
    requestedNodes: number;
    quorumK: number;
    retentionDays: number;
    declaredDownloadBytes: string;
    mediationMode: number;
    varianceMax: number;
    createResultControllerCap: number;
    storageSourceUrl?: string;
    payloadJson: any;
  };
};

type PreparedTaskScheduleWalletTransaction = {
  ok: true;
  mode: "prepare-task-schedule-webview";
  executionMode: "direct" | "scheduled";
  sender: string;
  serializedTransaction: string;
  gasBudget: string;
  initialFunds: string;
  requiredPayment: string;
  requiredPerRun: string;
  estimatedRuns: string | null;
  targetFunction: string;
  template: {
    templateId: number;
    taskType: string;
  };
  schedule: {
    startScheduleMs: string;
    endScheduleMs: string;
    intervalMs: string;
  };
  prepared: {
    templateId: number;
    taskType: string;
    requestedNodes: number;
    quorumK: number;
    retentionDays: number;
    declaredDownloadBytes: string;
    mediationMode: number;
    varianceMax: number;
    createResultControllerCap: number;
    storageSourceUrl?: string;
    payloadJson: any;
  };
};

type ScheduledTaskActionInput = {
  action: "suspend" | "reactivate" | "delete" | "fund";
  taskId: string;
  useSupervisor?: boolean;
  controllerCapId?: string;
  ownerCapId?: string;
  amount?: bigint;
};

type PreparedScheduledTaskActionWalletTransaction = {
  ok: true;
  mode: "prepare-scheduled-task-action-webview";
  sender: string;
  action: ScheduledTaskActionInput["action"];
  taskId: string;
  serializedTransaction: string;
  gasBudget: string;
  amount: string | null;
  useSupervisor: boolean;
  controllerCapId: string | null;
  ownerCapId: string | null;
  target: string;
};

const EMediationVarianceTooHigh = 401;

function mustEnv(k: string): string {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
}

function normalizeNetwork(raw: string | undefined): "devnet" | "testnet" | "mainnet" | "localnet" | "" {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "dev" || value === "devnet") return "devnet";
  if (value === "test" || value === "testnet") return "testnet";
  if (value === "main" || value === "mainnet") return "mainnet";
  if (value === "local" || value === "localnet") return "localnet";
  return "";
}

function networkPrefix(): "DEVNET" | "TESTNET" | "MAINNET" | "" {
  const network = normalizeNetwork(process.env.IOTA_NETWORK);
  if (network === "devnet" || network === "localnet") return "DEVNET";
  if (network === "testnet") return "TESTNET";
  if (network === "mainnet") return "MAINNET";
  return "";
}

function envAny(...keys: string[]): string | undefined {
  const prefix = networkPrefix();
  for (const k of keys) {
    if (prefix) {
      const scoped = process.env[`${prefix}_${k}`]?.trim();
      if (scoped) return scoped;
    }
    const v = process.env[k]?.trim();
    if (v) return v;
  }
  return undefined;
}

function getTasksPackageId(): string {
  const v = envAny("ORACLE_TASKS_PACKAGE_ID", "ORACLE_PACKAGE_ID");
  if (!v) throw new Error("Missing env ORACLE_TASKS_PACKAGE_ID (or legacy ORACLE_PACKAGE_ID)");
  return v;
}

function getSystemPackageId(): string {
  const v = envAny("ORACLE_SYSTEM_PACKAGE_ID");
  if (!v) throw new Error("Missing env ORACLE_SYSTEM_PACKAGE_ID");
  return v;
}

function getStateId(): string {
  const v = envAny("ORACLE_STATE_ID", "ORACLE_STATUS_ID", "ORACLE_SYSTEM_STATE_ID");
  if (!v) throw new Error("Missing env ORACLE_STATE_ID (or legacy ORACLE_STATUS_ID / ORACLE_SYSTEM_STATE_ID)");
  return v;
}

function getTreasuryId(): string {
  const v = envAny("ORACLE_TREASURY_ID", "ORACLE_TREASURY_OBJECT_ID");
  if (!v) throw new Error("Missing env ORACLE_TREASURY_ID");
  return v;
}

function getIotaSystemStateId(): string {
  return envAny("IOTA_SYSTEM_STATE_ID") ?? "0x5";
}

function getTaskRegistryId(): string {
  const v = envAny("ORACLE_TASK_REGISTRY_ID");
  if (!v) throw new Error("Missing env ORACLE_TASK_REGISTRY_ID");
  return v;
}

function getConfiguredNodeRegistryId(): string | undefined {
  return envAny("ORACLE_NODE_REGISTRY_ID");
}

async function chooseFundingSource(
  client: AnyClient,
  sender: string,
  requiredAmount: bigint,
  gasBudget: bigint,
): Promise<"gas" | "dedicated"> {
  const getCoins = (client as any)?.getCoins;
  if (typeof getCoins !== "function") return "gas";

  let cursor: string | null | undefined = null;
  let total = 0n;
  let largest = 0n;
  let count = 0;

  for (let pageNo = 0; pageNo < 20; pageNo += 1) {
    const page: any = await getCoins.call(client, {
      owner: sender,
      cursor,
      limit: 50,
    });

    for (const coin of page?.data ?? []) {
      const balance = BigInt(String((coin as any)?.balance ?? "0"));
      total += balance;
      if (balance > largest) largest = balance;
      count += 1;
    }

    if (!page?.hasNextPage || !page?.nextCursor) break;
    cursor = page.nextCursor;
  }

  if (count <= 1) return "gas";
  if (largest >= requiredAmount + gasBudget) return "gas";
  if (total >= requiredAmount + gasBudget) return "dedicated";
  return "gas";
}

function createFundingCoin(
  tx: Transaction,
  amount: bigint,
  fundingSource: "gas" | "dedicated",
) {
  if (fundingSource === "dedicated") {
    return coinWithBalance({ balance: amount, useGasCoin: false })(tx);
  }

  const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure(bcsU64(amount))]);
  return paymentCoin;
}

function moveToString(value: any): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (!value || typeof value !== "object") return "";
  for (const key of ["value", "id", "objectId", "bytes", "address"]) {
    const nested = (value as any)[key];
    if (typeof nested === "string" || typeof nested === "number" || typeof nested === "bigint") {
      return String(nested);
    }
  }
  if ((value as any).fields) return moveToString((value as any).fields);
  if ((value as any).data) return moveToString((value as any).data);
  return "";
}

async function resolveNodeRegistryId(client: AnyClient, stateId: string): Promise<string> {
  const configured = getConfiguredNodeRegistryId()?.trim();
  if (configured) return configured;
  const obj = await client.getObject({ id: stateId, options: { showContent: true } } as any);
  const fields = getMoveFields(obj);
  const nodeRegistryId = moveToString(fields.node_registry_id).trim();
  if (!nodeRegistryId) throw new Error(`State ${stateId} does not expose node_registry_id`);
  return nodeRegistryId;
}

function loadTaskJson(arg?: string): any {
  if (!arg) {
    const defaults = ["task.json", "examples/task.json", "examples/task_weather.json", "examples/task_storage.json"];
    for (const d of defaults) {
      const p = path.resolve(process.cwd(), d);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      }
    }
    throw new Error("Usage: npm run create -- <task.json | inline-json>");
  }

  const p = path.resolve(process.cwd(), arg);
  const raw = fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, "utf8") : arg;
  return JSON.parse(raw);
}

function loadJsonArg(arg: string | undefined, usage: string): any {
  if (!arg) throw new Error(usage);
  const p = path.resolve(process.cwd(), arg);
  const raw = fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, "utf8") : arg;
  return JSON.parse(raw);
}

function parsePositiveInt(raw: unknown, field: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${field}: ${String(raw)}`);
  return Math.floor(n);
}

function parseRequestedNodes(taskObj: any): number {
  return parsePositiveInt(taskObj?.requested_nodes ?? taskObj?.nodes ?? 3, "requested_nodes");
}

function parseQuorumK(taskObj: any, requestedNodes: number): number {
  const q = taskObj?.consensus?.quorum;
  if (!q) return requestedNodes;

  const qt = String(q.type ?? "").toLowerCase();
  const v = Number(q.value);

  if (qt === "abs" || qt === "n") {
    const k = Math.floor(v);
    if (!Number.isFinite(k) || k <= 0 || k > requestedNodes) throw new Error(`Invalid quorum abs value: ${q.value}`);
    return k;
  }

  if (qt === "pct") {
    if (!Number.isFinite(v) || v <= 0 || v > 1) throw new Error(`Invalid quorum pct value: ${q.value}`);
    const k = Math.ceil(v * requestedNodes);
    return Math.max(1, Math.min(requestedNodes, k));
  }

  return requestedNodes;
}

function parseTemplateId(taskObj: any): number {
  const raw = taskObj?.template_id ?? taskObj?.templateId;
  if (raw == null) throw new Error('Task JSON must contain numeric "template_id"');
  return parsePositiveInt(raw, "template_id");
}

function parseRetentionDays(taskObj: any): number {
  const raw =
    taskObj?.retention_days ??
    taskObj?.retentionDays ??
    taskObj?.storage?.retention_days ??
    taskObj?.storage?.retentionDays ??
    0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid retention_days: ${String(raw)}`);
  return Math.floor(n);
}

function parseDeclaredDownloadBytes(taskObj: any): bigint {
  const raw =
    taskObj?.declared_download_bytes ??
    taskObj?.declaredDownloadBytes ??
    taskObj?.source?.declared_download_bytes ??
    taskObj?.source?.declaredDownloadBytes ??
    taskObj?.storage?.declared_download_bytes ??
    taskObj?.storage?.declaredDownloadBytes;

  if (raw == null || raw === "") return 0n;

  try {
    const n = BigInt(String(raw).trim());
    if (n < 0n) throw new Error("negative");
    return n;
  } catch {
    throw new Error(`Invalid declared_download_bytes: ${String(raw)}`);
  }
}

function parseCreateResultControllerCap(taskObj: any): number {
  const raw =
    taskObj?.create_result_controller_cap ??
    taskObj?.createResultControllerCap ??
    taskObj?.result?.create_result_controller_cap ??
    taskObj?.result?.createResultControllerCap ??
    0;

  if (typeof raw === "boolean") return raw ? 1 : 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || (n !== 0 && n !== 1)) {
    throw new Error("Invalid create_result_controller_cap. Allowed: true/false or 0/1.");
  }
  return Math.floor(n);
}

function parseTimestampMs(raw: unknown, field: string): bigint {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) throw new Error(`Missing ${field}`);
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed >= 0) return BigInt(Math.floor(parsed));
    throw new Error(`Invalid ${field}: ${String(raw)}`);
  }

  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return BigInt(Math.floor(raw));
  }

  throw new Error(`Invalid ${field}: ${String(raw)}`);
}

function parseNonNegativeBigInt(raw: unknown, field: string): bigint {
  try {
    const value = BigInt(String(raw ?? "").trim());
    if (value < 0n) throw new Error("negative");
    return value;
  } catch {
    throw new Error(`Invalid ${field}: ${String(raw)}`);
  }
}

function parseIotaToNano(raw: unknown, field: string): bigint {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error(`Missing ${field}`);
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`Invalid ${field}: ${String(raw)}`);
  const [wholePart, fracPart = ""] = text.split(".");
  const whole = BigInt(wholePart || "0") * 1_000_000_000n;
  const frac = BigInt((fracPart + "000000000").slice(0, 9) || "0");
  return whole + frac;
}

const SCHEDULE_ALIGNMENT_MS = 60_000n;

const MIN_SCHEDULE_INTERVAL_MS = 300_000n;

function assertMinuteAligned(value: bigint, field: string): void {
  if (value % SCHEDULE_ALIGNMENT_MS !== 0n) {
    throw new Error(`${field} must be aligned to the start of a minute (seconds must be 00).`);
  }
}

function normalizeScheduleInput(input: any): ScheduleInput {
  const startRaw = input?.start_schedule_ms ?? input?.startScheduleMs ?? input?.start ?? input?.startAt;
  const endRaw = input?.end_schedule_ms ?? input?.endScheduleMs ?? input?.end ?? input?.endAt ?? 0;
  const intervalRaw =
    input?.interval_ms ??
    input?.intervalMs ??
    (input?.interval_minutes != null
      ? BigInt(input.interval_minutes) * 60_000n
      : input?.intervalMinutes != null
        ? BigInt(input.intervalMinutes) * 60_000n
        : 0n);
  const fundsRaw =
    input?.initial_funds_nano_iota ??
    input?.initialFundsNanoIota ??
    input?.initial_funds_iota ??
    input?.initialFundsIota;

  if (fundsRaw == null || String(fundsRaw).trim() === "") throw new Error("Missing initial funds for schedule.");

  const startScheduleMs = parseTimestampMs(startRaw, "start_schedule_ms");
  const endScheduleMs = endRaw === 0 || endRaw === "0" || endRaw == null || String(endRaw).trim() === "" ? 0n : parseTimestampMs(endRaw, "end_schedule_ms");
  const intervalMs = parseNonNegativeBigInt(intervalRaw, "interval_ms");
  const initialFunds =
    input?.initial_funds_nano_iota != null || input?.initialFundsNanoIota != null
      ? parseNonNegativeBigInt(fundsRaw, "initial_funds_nano_iota")
      : parseIotaToNano(fundsRaw, "initial_funds_iota");

  assertMinuteAligned(startScheduleMs, "start_schedule_ms");
  assertMinuteAligned(intervalMs, "interval_ms");
  if (endScheduleMs !== 0n) assertMinuteAligned(endScheduleMs, "end_schedule_ms");
  if (intervalMs !== 0n && intervalMs < MIN_SCHEDULE_INTERVAL_MS) {
    throw new Error("interval_ms must be at least 300000 ms (5 minutes).");
  }

  return {
    startScheduleMs,
    endScheduleMs,
    intervalMs,
    initialFunds,
  };
}

function toPlainStringMap(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "string" && k.trim()) out[k] = v;
  }
  return out;
}

function pickStorageSourceUrl(taskObj: any): string {
  const sourceUrl = typeof taskObj?.source?.url === "string" ? taskObj.source.url.trim() : "";
  if (!sourceUrl) throw new Error("STORAGE task requires source.url");
  if (!/^https?:\/\//i.test(sourceUrl)) {
    throw new Error(`STORAGE source.url must start with http:// or https://: ${sourceUrl}`);
  }
  return sourceUrl;
}

function parseStorageProbeTimeoutMs(taskObj: any): number {
  const raw =
    taskObj?.timeouts?.step1Ms ??
    taskObj?.timeouts?.storageProbeMs ??
    taskObj?.storage?.probe_timeout_ms ??
    taskObj?.storage?.probeTimeoutMs ??
    process.env.STORAGE_PROBE_TIMEOUT_MS ??
    15000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 15000;
  return Math.floor(n);
}

async function probeStorageContentLength(taskObj: any): Promise<bigint> {
  const sourceUrl = pickStorageSourceUrl(taskObj);
  const headers = toPlainStringMap(taskObj?.source?.headers);
  const timeoutMs = parseStorageProbeTimeoutMs(taskObj);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const extractSize = (res: Response): bigint | null => {
    const contentRange = res.headers.get("content-range")?.trim() ?? "";
    const m = contentRange.match(/\/(\d+)$/);
    if (m) return BigInt(m[1]);

    const contentLength = res.headers.get("content-length")?.trim() ?? "";
    if (contentLength) return BigInt(contentLength);

    return null;
  };

  try {
    const attempts: Array<() => Promise<Response>> = [
      () =>
        fetch(sourceUrl, {
          method: "HEAD",
          headers,
          redirect: "follow",
          signal: controller.signal,
        }),
      () =>
        fetch(sourceUrl, {
          method: "GET",
          headers: { ...headers, Range: "bytes=0-0" },
          redirect: "follow",
          signal: controller.signal,
        }),
    ];

    const errors: string[] = [];

    for (const attempt of attempts) {
      try {
        const res = await attempt();
        if (!res.ok) {
          errors.push(`HTTP ${res.status} ${res.statusText}`);
          continue;
        }

        const n = extractSize(res);
        if (n != null && n >= 0n) return n;

        errors.push("Missing Content-Length/Content-Range");
      } catch (e: any) {
        errors.push(String(e?.message ?? e));
      }
    }

    throw new Error(errors.join(" | "));
  } catch (e: any) {
    throw new Error(`Unable to determine STORAGE content length for ${sourceUrl}: ${String(e?.message ?? e)}`);
  } finally {
    clearTimeout(timer);
  }
}

function parseMediationMode(taskObj: any): number {
  const raw = taskObj?.mediation_mode ?? taskObj?.mediationMode ?? taskObj?.mediation?.mode;
  if (raw == null) return 0;

  if (typeof raw === "number") return Math.floor(raw);
  const s = String(raw).trim().toLowerCase();
  if (!s || s === "none" || s === "off" || s === "disabled" || s === "0") return 0;
  if (s === "mean_u64" || s === "meanu64" || s === "mean" || s === "1") return 1;
  return Number.NaN;
}

function parseVarianceMax(taskObj: any): number {
  const raw =
    taskObj?.variance_max ??
    taskObj?.varianceMax ??
    taskObj?.mediation?.variance_max ??
    taskObj?.mediation?.varianceMax;
  if (raw == null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return Number.NaN;
  return Math.floor(n);
}

function getMoveFields(obj: any): Record<string, any> {
  const c: any = obj?.data?.content;
  if (!c || c.dataType !== "moveObject") return {};
  return (c.fields ?? {}) as Record<string, any>;
}

function unwrapFieldValue(obj: any): Record<string, any> {
  const fields = getMoveFields(obj);
  const value = fields.value;
  if (value && typeof value === "object") {
    if ((value as any).fields && typeof (value as any).fields === "object") return (value as any).fields;
    return value as Record<string, any>;
  }
  return fields;
}

function moveObjectIdToString(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (!v || typeof v !== "object") return "";

  const o: any = v;
  const direct = [o.objectId, o.id, o.bytes, o.value];
  for (const candidate of direct) {
    const resolved = moveObjectIdToString(candidate);
    if (resolved) return resolved;
  }

  if (o.fields && typeof o.fields === "object") {
    const resolved = moveObjectIdToString(o.fields);
    if (resolved) return resolved;
  }

  for (const val of Object.values(o)) {
    const resolved = moveObjectIdToString(val);
    if (resolved) return resolved;
  }

  return "";
}

function asBigInt(v: unknown, fallback = 0n): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.floor(v));
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return fallback;
    try {
      return BigInt(t);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function normalizeTaskPayload(taskObj: any): PreparedTask {
  const templateId = parseTemplateId(taskObj);
  const taskType = String(taskObj?.type ?? "").trim();
  if (!taskType) throw new Error('Task JSON must contain a non-empty top-level "type" field');

  const requestedNodes = parseRequestedNodes(taskObj);
  const quorumK = parseQuorumK(taskObj, requestedNodes);
  const mediationMode = parseMediationMode(taskObj);
  if (!Number.isFinite(mediationMode) || (mediationMode !== 0 && mediationMode !== 1)) {
    throw new Error("Invalid mediation_mode. Allowed: 0 (none) or 1 (mean_u64).");
  }
  const varianceMax = parseVarianceMax(taskObj);
  if (!Number.isFinite(varianceMax)) {
    throw new Error("Invalid variance_max. Must be a non-negative integer.");
  }
  const retentionDays = parseRetentionDays(taskObj);
  const createResultControllerCap = parseCreateResultControllerCap(taskObj);

  const payloadJson: any = { ...taskObj, requested_nodes: requestedNodes };
  delete payloadJson.nodes;

  let declaredDownloadBytes = 0n;
  let storageSourceUrl: string | undefined;

  if (taskType === "STORAGE") {
    storageSourceUrl = pickStorageSourceUrl(taskObj);
    declaredDownloadBytes = parseDeclaredDownloadBytes(taskObj);

    payloadJson.source = {
      ...(typeof payloadJson.source === "object" && payloadJson.source ? payloadJson.source : {}),
      url: storageSourceUrl,
      headers: toPlainStringMap(taskObj?.source?.headers),
    };

    if (declaredDownloadBytes > 0n) {
      payloadJson.declared_download_bytes = declaredDownloadBytes.toString();
    }
  }

  const payloadText = JSON.stringify(payloadJson);

  return {
    templateId,
    taskType,
    payloadJson,
    payloadText,
    requestedNodes,
    quorumK,
    mediationMode,
    varianceMax,
    retentionDays,
    declaredDownloadBytes,
    createResultControllerCap,
    storageSourceUrl,
  };
}
async function getStateEconomics(client: AnyClient, stateId: string): Promise<StateEconomics> {
  const obj = await client.getObject({ id: stateId, options: { showContent: true } });
  const f = getMoveFields(obj);
  return {
    systemFeeBps: asBigInt(f.system_fee_bps),
    minPayment: asBigInt(f.min_payment),
  };
}

async function getTaskTemplateById(
  client: any,
  stateId: string,
  systemPkg: string,
  templateId: number,
): Promise<TaskTemplateInfo | null> {
  try {
    const obj = await client.getDynamicFieldObject({
      parentId: stateId,
      name: {
        type: `${systemPkg}::systemState::TaskTemplateKey`,
        value: { template_id: templateId },
      },
    } as any);

    const v: any = unwrapFieldValue(obj);
    return {
      templateId: asNumber(v.template_id, templateId),
      taskType: bytesToUtf8(decodeVecU8(v.task_type)),
      isEnabled: asNumber(v.is_enabled),
      basePriceIota: asBigInt(v.base_price_iota),
      schedulerFeeIota: asBigInt(v.scheduler_fee_iota),
      maxInputBytes: asBigInt(v.max_input_bytes),
      maxOutputBytes: asBigInt(v.max_output_bytes),
      includedDownloadBytes: asBigInt(v.included_download_bytes),
      pricePerDownloadByteIota: asBigInt(v.price_per_download_byte_iota),
      allowStorage: asNumber(v.allow_storage),
      minRetentionDays: asBigInt(v.min_retention_days),
      maxRetentionDays: asBigInt(v.max_retention_days),
      pricePerRetentionDayIota: asBigInt(v.price_per_retention_day_iota),
    };
  } catch {
    // fall through to scan
  }

  let cursor: string | null = null;

  for (;;) {
    const page: any = await client.getDynamicFields({
      parentId: stateId,
      cursor,
      limit: 50,
    });

    for (const row of (page?.data ?? []) as any[]) {
      const rowName: any = row?.name ?? null;
      const rowType = String(rowName?.type ?? "");
      const rowValue: any = rowName?.value ?? null;
      const rowTemplateId = Number(rowValue?.template_id ?? rowValue?.templateId ?? NaN);

      const looksLikeTemplate =
        rowType.includes("TaskTemplateKey") || String(row?.objectType ?? "").includes("TaskTemplate");

      if (!looksLikeTemplate || rowTemplateId !== templateId) continue;

      const obj = await client.getObject({
        id: row.objectId,
        options: { showContent: true, showType: true },
      });

      const v: any = unwrapFieldValue(obj);
      return {
        templateId: asNumber(v.template_id, templateId),
        taskType: bytesToUtf8(decodeVecU8(v.task_type)),
        isEnabled: asNumber(v.is_enabled),
        basePriceIota: asBigInt(v.base_price_iota),
        schedulerFeeIota: asBigInt(v.scheduler_fee_iota),
        maxInputBytes: asBigInt(v.max_input_bytes),
        maxOutputBytes: asBigInt(v.max_output_bytes),
        includedDownloadBytes: asBigInt(v.included_download_bytes),
        pricePerDownloadByteIota: asBigInt(v.price_per_download_byte_iota),
        allowStorage: asNumber(v.allow_storage),
        minRetentionDays: asBigInt(v.min_retention_days),
        maxRetentionDays: asBigInt(v.max_retention_days),
        pricePerRetentionDayIota: asBigInt(v.price_per_retention_day_iota),
      };
    }

    if (!page?.hasNextPage) break;
    cursor = page?.nextCursor ?? null;
  }

  return null;
}
function validateAgainstTemplate(prepared: PreparedTask, template: TaskTemplateInfo, economics: StateEconomics) {
  if (template.isEnabled !== 1) {
    throw new Error(`Template ${template.templateId} exists but is disabled`);
  }

  const payloadBytes = Buffer.byteLength(prepared.payloadText, "utf8");
  if (template.maxInputBytes > 0n && BigInt(payloadBytes) > template.maxInputBytes) {
    throw new Error(
      `Payload too large for template ${template.templateId}: ${payloadBytes} bytes > max_input_bytes=${template.maxInputBytes.toString()}`,
    );
  }

  if (template.allowStorage === 0 && prepared.retentionDays > 0) {
    throw new Error(
      `Template ${template.templateId} does not allow storage but task asks retention_days=${prepared.retentionDays}`,
    );
  }

  if (template.allowStorage === 1) {
    if (BigInt(prepared.retentionDays) < template.minRetentionDays) {
      throw new Error(
        `retention_days=${prepared.retentionDays} below template minimum ${template.minRetentionDays.toString()} for template ${template.templateId}`,
      );
    }
    if (template.maxRetentionDays > 0n && BigInt(prepared.retentionDays) > template.maxRetentionDays) {
      throw new Error(
        `retention_days=${prepared.retentionDays} above template maximum ${template.maxRetentionDays.toString()} for template ${template.templateId}`,
      );
    }
  }

  if (template.taskType && template.taskType !== prepared.taskType) {
    throw new Error(
      `Template ${template.templateId} expects task_type=${template.taskType}, but task JSON requested type=${prepared.taskType}`,
    );
  }

  if (prepared.taskType === "STORAGE") {
    if (prepared.retentionDays !== 30) {
      throw new Error("STORAGE task requires retention_days=30");
    }
    if (prepared.declaredDownloadBytes <= 0n) {
      throw new Error("STORAGE task requires declared_download_bytes > 0");
    }
    if (template.maxOutputBytes > 0n && prepared.declaredDownloadBytes > template.maxOutputBytes) {
      throw new Error(
        `STORAGE declared_download_bytes=${prepared.declaredDownloadBytes.toString()} exceeds template max_output_bytes=${template.maxOutputBytes.toString()} for template ${template.templateId}`,
      );
    }
  }

  const extraDownloadBytes =
    prepared.declaredDownloadBytes > template.includedDownloadBytes
      ? prepared.declaredDownloadBytes - template.includedDownloadBytes
      : 0n;
  const downloadPrice = extraDownloadBytes * template.pricePerDownloadByteIota;
  const perNodeRawPrice =
    template.basePriceIota + downloadPrice + BigInt(prepared.retentionDays) * template.pricePerRetentionDayIota;
  const rawPrice = perNodeRawPrice * BigInt(prepared.requestedNodes);
  const systemFee = rawPrice === 0n || economics.systemFeeBps === 0n ? 0n : (rawPrice * economics.systemFeeBps + 9999n) / 10000n;
  const totalPrice = rawPrice + systemFee;
  const requiredPayment = totalPrice > economics.minPayment ? totalPrice : economics.minPayment;
  const requiredPerRun = requiredPayment + template.schedulerFeeIota;
  return { rawPrice, systemFee, totalPrice, requiredPayment, requiredPerRun, downloadPrice, extraDownloadBytes };
}

async function fetchIotaBalance(client: AnyClient, owner: string): Promise<bigint> {
  const bal = await client.getBalance({ owner, coinType: "0x2::iota::IOTA" });
  return asBigInt(bal?.totalBalance, 0n);
}

async function fetchTreasuryBalance(client: AnyClient, treasuryId: string, systemPkg: string): Promise<bigint | null> {
  const keyType = `${systemPkg}::systemState::OracleTreasuryBalanceKey`;
  const names = [
    { type: keyType, value: {} },
    { type: keyType, value: null as any },
  ];

  for (const name of names) {
    try {
      const df = await client.getDynamicFieldObject({ parentId: treasuryId, name } as any);
      const v = unwrapFieldValue(df) as any;
      const direct = asBigInt(v?.balance, -1n);
      if (direct >= 0n) return direct;
      const nested = asBigInt(v?.fields?.balance, -1n);
      if (nested >= 0n) return nested;
      const coinValue = asBigInt(v?.value, -1n);
      if (coinValue >= 0n) return coinValue;
    } catch {
      // continue
    }
  }

  let cursor: any = null;
  for (;;) {
    const page = await client.getDynamicFields({ parentId: treasuryId, cursor, limit: 50 });
    for (const row of page.data ?? []) {
      const rowType = String(row?.name?.type ?? "");
      if (!rowType.includes("OracleTreasuryBalanceKey")) continue;
      try {
        const obj = await client.getObject({ id: row.objectId, options: { showContent: true, showType: true } });
        const v = unwrapFieldValue(obj) as any;
        const direct = asBigInt(v?.balance, -1n);
        if (direct >= 0n) return direct;
        const nested = asBigInt(v?.fields?.balance, -1n);
        if (nested >= 0n) return nested;
      } catch {
        // ignore and continue scan
      }
    }
    if (!page.hasNextPage) break;
    cursor = page.nextCursor;
  }

  return null;
}

function isTaskFinalizedObjectFields(f: Record<string, any>): boolean {
  return asBigInt(f.latest_result_seq, 0n) > 0n || Number(f.execution_state ?? f.state ?? -1) === 9;
}

async function isTaskFinalized(client: AnyClient, taskId: string): Promise<boolean> {
  const obj = await client.getObject({ id: taskId, options: { showContent: true } });
  return isTaskFinalizedObjectFields(getMoveFields(obj));
}

type TaskResultState = {
  seq: bigint;
  fields: Record<string, any>;
};

type TaskCompositeState = {
  taskId: string;
  taskFields: Record<string, any>;
  latestResult: TaskResultState | null;
};

async function readTaskCompositeState(client: AnyClient, taskId: string): Promise<TaskCompositeState> {
  const taskObj = await client.getObject({ id: taskId, options: { showContent: true, showType: true } });
  const taskFields = getMoveFields(taskObj);
  const latestResultSeq = asBigInt(taskFields.latest_result_seq, 0n);
  let latestResult: TaskResultState | null = null;

  if (latestResultSeq > 0n) {
    try {
      const tasksPkg = getTasksPackageId();
      const resultObj = await client.getDynamicFieldObject({
        parentId: taskId,
        name: {
          type: `${tasksPkg}::oracle_tasks::TaskResultKey`,
          value: { seq: latestResultSeq.toString() },
        },
      } as any);
      latestResult = {
        seq: latestResultSeq,
        fields: unwrapFieldValue(resultObj),
      };
    } catch {
      latestResult = {
        seq: latestResultSeq,
        fields: {},
      };
    }
  }

  return {
    taskId,
    taskFields,
    latestResult,
  };
}

function readTaskMediationMeta(snapshot: TaskCompositeState): {
  mediationMode: number;
  mediationAttempts: number;
  mediationStatus: number;
  mediationVariance: number;
} {
  const task = snapshot.taskFields;

  return {
    mediationMode: Number(task.mediation_mode ?? 0),
    mediationAttempts: Number(task.active_round ?? 0),
    mediationStatus: Number(task.execution_state ?? 0),
    mediationVariance: Number(task.variance_max ?? 0),
  };
}

async function waitTaskCompletedOrResult(opts: {
  client: AnyClient;
  taskId: string;
  timeoutMs?: number;
  pollMs?: number;
}) {
  const { client, taskId } = opts;
  const timeoutMs = opts.timeoutMs ?? Number(process.env.WAIT_TIMEOUT_MS ?? "180000");
  const pollMs = opts.pollMs ?? Number(process.env.EVENT_POLL_MS ?? "1200");

  const started = Date.now();
  let lastLog = 0;

  while (Date.now() - started < timeoutMs) {
    const snapshot = await readTaskCompositeState(client, taskId);
    const task = snapshot.taskFields;
    const state = Number(task.execution_state ?? task.state ?? -1);
    const round = Number(task.active_round ?? 0);
    const { mediationMode, mediationAttempts, mediationStatus, mediationVariance } = readTaskMediationMeta(snapshot);

    const resultBytes = snapshot.latestResult ? decodeVecU8(snapshot.latestResult.fields.result) : new Uint8Array();
    if (snapshot.latestResult || resultBytes.length > 0 || state === 9) return { kind: "finalized" as const, state };

    if (state === 10) {
      const mediationEnabled = mediationMode === 1;
      if (mediationEnabled && (mediationStatus === 2 || mediationAttempts > 0)) {
        const reason = mediationStatus === 2 ? "mediation_blocked" : "mediation_attempted";
        console.log(
          `[client] terminal no_consensus via failed state (${reason}, round=${round}, attempts=${mediationAttempts}, status=${mediationStatus}, variance=${mediationVariance})`,
        );
        return { kind: "no_consensus" as const, state };
      }
      return { kind: "failed" as const, state };
    }

    if (state === 2 && mediationMode === 1) {
      const now = Date.now();
      if (now - lastLog > 10_000) {
        console.log(
          `[client] mediation pending -> keep waiting (round=${round}, attempts=${mediationAttempts}, status=${mediationStatus}, variance_limit=${mediationVariance})`,
        );
        lastLog = now;
      }
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(`Timeout waiting terminal state for taskId=${taskId}`);
}

function getTxStatusInfo(res: any): { status: string; error: string } {
  const status = String(res?.effects?.status?.status ?? res?.effects?.status ?? "").trim();
  const error = String(res?.effects?.status?.error ?? "").trim();
  return { status, error };
}

async function fetchFullTransactionBlock(client: AnyClient, digest: string): Promise<any | null> {
  const getTx = (client as any).getTransactionBlock;
  if (typeof getTx !== "function") return null;
  try {
    return await getTx.call(client, {
      digest,
      options: { showEffects: true, showEvents: true, showObjectChanges: true, showInput: true },
    });
  } catch {
    return null;
  }
}

function mergeTxResults(primary: any, fallback: any): any {
  if (!fallback) return primary;
  return {
    ...primary,
    ...fallback,
    effects: fallback.effects ?? primary.effects,
    events: fallback.events ?? primary.events,
    objectChanges: fallback.objectChanges ?? primary.objectChanges,
    digest: fallback.digest ?? primary.digest,
  };
}

async function hydrateExecutedTransaction(client: AnyClient, res: any): Promise<any> {
  const digest = String(res?.digest ?? "").trim();
  if (!digest) return res;

  const full = await fetchFullTransactionBlock(client, digest);
  return mergeTxResults(res, full);
}

function requireSuccessfulTransaction(res: any) {
  const { status, error } = getTxStatusInfo(res);
  if (!status) return;
  if (status.toLowerCase() == "success") return;
  throw new Error(`create_task transaction failed: status=${status}${error ? ` error=${error}` : ""}`);
}

function extractEventsArray(res: any): any[] {
  if (!res) return [];
  if (Array.isArray(res.events)) return res.events;
  const d = (res.events as any)?.data;
  return Array.isArray(d) ? d : [];
}

function extractTaskIdFromTx(res: any): string {
  const events = extractEventsArray(res);
  const createdEv = events.find(
    (e) =>
      String(e.type ?? "").endsWith("::oracle_tasks::TaskLifecycleEvent") && Number(e.parsedJson?.kind ?? -1) === 1,
  );
  const eventTaskId = createdEv?.parsedJson?.task_id;
  const byEvent =
    typeof eventTaskId === "string"
      ? eventTaskId.trim()
      : String((eventTaskId as any)?.id ?? (eventTaskId as any)?.objectId ?? (eventTaskId as any)?.bytes ?? "").trim();
  if (byEvent) return byEvent;

  const oc: any[] = Array.isArray(res.objectChanges) ? res.objectChanges : [];
  const createdTask = oc.find(
    (c) =>
      c.type === "created" &&
      String(c.objectType ?? "").endsWith("::oracle_tasks::Task"),
  );
  const byTaskObj = String(createdTask?.objectId ?? "").trim();
  if (byTaskObj) return byTaskObj;

  const ownerCap = oc.find(
    (c) => c.type === "created" && String(c.objectType ?? "").includes("::oracle_tasks::TaskOwnerCap"),
  );
  const capTaskId = String(
    ownerCap?.fields?.task_id ?? ownerCap?.content?.fields?.task_id ?? ownerCap?.data?.content?.fields?.task_id ?? "",
  ).trim();
  if (capTaskId) return capTaskId;

  const created = Array.isArray(res?.effects?.created) ? res.effects.created : [];
  for (const row of created) {
    const objectId = String(row?.reference?.objectId ?? row?.objectId ?? "").trim();
    if (objectId) return objectId;
  }

  return "";
}

function makeCreateAndSubmitDirectTaskTx(ctx: CreateTaskContext): Transaction {
  const { tasksPkg, stateId, nodeRegistryId, treasuryId, randomId, clockId, prepared, requiredPayment, gasBudget, fundingSource } = ctx;
  const tx = new Transaction();
  tx.setGasBudget(Number(gasBudget));
  const paymentCoin = createFundingCoin(tx, requiredPayment, fundingSource);

  tx.moveCall({
    target: `${tasksPkg}::oracle_tasks::create_and_submit_direct_task`,
    arguments: [
      tx.object(stateId),
      tx.object(nodeRegistryId),
      tx.object(treasuryId),
      paymentCoin,
      tx.pure(bcsU64(prepared.templateId)),
      tx.pure(bcsU64(prepared.requestedNodes)),
      tx.pure(bcsU64(prepared.quorumK)),
      tx.pure(bcsVecU8(utf8ToBytes(prepared.payloadText))),
      tx.pure(bcsU64(prepared.retentionDays)),
      tx.pure(bcsU64(prepared.declaredDownloadBytes)),
      tx.pure(bcsU8(prepared.mediationMode)),
      tx.pure(bcsU64(prepared.varianceMax)),
      tx.pure(bcsU8(prepared.createResultControllerCap)),
      tx.object(randomId),
      tx.object(clockId),
    ],
  });
  return tx;
}

function buildCreateTaskVariants(ctx: CreateTaskContext): Record<string, () => Transaction> {
  return {
    direct_task_v1: () => makeCreateAndSubmitDirectTaskTx(ctx),
  };
}

function isRecurringSchedule(schedule: ScheduleInput): boolean {
  return (
    schedule.intervalMs >= MIN_SCHEDULE_INTERVAL_MS &&
    (schedule.endScheduleMs === 0n || schedule.endScheduleMs > schedule.startScheduleMs)
  );
}

function estimateScheduleRuns(schedule: ScheduleInput): string | null {
  if (!isRecurringSchedule(schedule)) return "1";
  if (schedule.endScheduleMs === 0n) return null;
  return ((schedule.endScheduleMs - schedule.startScheduleMs) / schedule.intervalMs + 1n).toString();
}

function makeCreateTaskWithScheduleTx(args: {
  tasksPkg: string;
  registryId: string;
  stateId: string;
  nodeRegistryId: string;
  prepared: PreparedTask;
  schedule: ScheduleInput;
  gasBudget: bigint;
  fundingSource: "gas" | "dedicated";
}): Transaction {
  const { tasksPkg, registryId, stateId, nodeRegistryId, prepared, schedule, gasBudget, fundingSource } = args;
  const tx = new Transaction();
  tx.setGasBudget(Number(gasBudget));
  const fundingCoin = createFundingCoin(tx, schedule.initialFunds, fundingSource);
  tx.moveCall({
    target: `${tasksPkg}::oracle_tasks::create_task`,
    arguments: [
      tx.object(registryId),
      tx.object(stateId),
      tx.object(nodeRegistryId),
      fundingCoin,
      tx.pure(bcsU64(prepared.templateId)),
      tx.pure(bcsU64(prepared.requestedNodes)),
      tx.pure(bcsU64(prepared.quorumK)),
      tx.pure(bcsVecU8(utf8ToBytes(prepared.payloadText))),
      tx.pure(bcsU64(prepared.retentionDays)),
      tx.pure(bcsU64(prepared.declaredDownloadBytes)),
      tx.pure(bcsU8(prepared.mediationMode)),
      tx.pure(bcsU64(prepared.varianceMax)),
      tx.pure(bcsU8(prepared.createResultControllerCap)),
      tx.pure(bcsU64(schedule.startScheduleMs)),
      tx.pure(bcsU64(schedule.endScheduleMs)),
      tx.pure(bcsU64(schedule.intervalMs)),
    ],
  });
  return tx;
}

function makeCreateTaskForScheduleInputTx(args: {
  tasksPkg: string;
  registryId: string;
  stateId: string;
  nodeRegistryId: string;
  treasuryId: string;
  randomId: string;
  clockId: string;
  prepared: PreparedTask;
  requiredPayment: bigint;
  schedule: ScheduleInput;
  gasBudget: bigint;
  fundingSource: "gas" | "dedicated";
}): { tx: Transaction; executionMode: "direct" | "scheduled"; targetFunction: string } {
  if (isRecurringSchedule(args.schedule)) {
    return {
      tx: makeCreateTaskWithScheduleTx(args),
      executionMode: "scheduled",
      targetFunction: "create_task",
    };
  }

  return {
    tx: makeCreateAndSubmitDirectTaskTx({
      tasksPkg: args.tasksPkg,
      registryId: args.registryId,
      stateId: args.stateId,
      nodeRegistryId: args.nodeRegistryId,
      iotaSystemStateId: getIotaSystemStateId(),
      treasuryId: args.treasuryId,
      randomId: args.randomId,
      clockId: args.clockId,
      prepared: args.prepared,
      requiredPayment: args.requiredPayment,
      requiredPerRun: args.requiredPayment,
      gasBudget: args.gasBudget,
      fundingSource: args.fundingSource,
    }),
    executionMode: "direct",
    targetFunction: "create_and_submit_direct_task",
  };
}

function normalizeObjectId(raw: unknown, field: string): string {
  const value = String(raw ?? "").trim();
  if (!value) throw new Error(`Missing ${field}.`);
  return value;
}

function normalizeScheduledTaskActionInput(input: any): ScheduledTaskActionInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Scheduled task action payload must be a JSON object.");
  }

  const action = String(input.action ?? "").trim().toLowerCase();
  const taskId = normalizeObjectId(input.taskId ?? input.task_id, "taskId");

  const useSupervisor =
    input.useSupervisor === true ||
    input.use_supervisor === true ||
    input.actor === "supervisor" ||
    input.mode === "supervisor";

  if (action === "suspend" || action === "reactivate" || action === "delete") {
    const ownerCapRaw = input.ownerCapId ?? input.owner_cap_id;
    return {
      action,
      taskId,
      useSupervisor,
      ownerCapId:
        !useSupervisor && ownerCapRaw != null && String(ownerCapRaw).trim()
          ? normalizeObjectId(ownerCapRaw, "ownerCapId")
          : undefined,
      controllerCapId: useSupervisor
        ? normalizeObjectId(input.controllerCapId ?? input.controller_cap_id, "controllerCapId")
        : undefined,
    };
  }

  if (action === "fund") {
    const amountRaw = input.amountNanoIota ?? input.amount_nano_iota ?? input.amountIota ?? input.amount_iota;
    if (amountRaw == null || String(amountRaw).trim() === "") {
      throw new Error("Missing funding amount.");
    }

    const amount =
      input.amountNanoIota != null || input.amount_nano_iota != null
        ? parseNonNegativeBigInt(amountRaw, "amount_nano_iota")
        : parseIotaToNano(amountRaw, "amount_iota");

    if (amount <= 0n) {
      throw new Error("Funding amount must be greater than zero.");
    }

    return {
      action,
      taskId,
      amount,
    };
  }

  throw new Error(`Unsupported scheduled task action: ${String(input.action ?? "")}`);
}

function makeScheduledTaskActionTx(args: {
  tasksPkg: string;
  registryId: string;
  clockId: string;
  gasBudget: bigint;
  input: ScheduledTaskActionInput;
}): { tx: Transaction; target: string } {
  const { tasksPkg, registryId, clockId, gasBudget, input } = args;
  const tx = new Transaction();
  tx.setGasBudget(Number(gasBudget));

  if (input.action === "suspend") {
    const target = input.useSupervisor
      ? `${tasksPkg}::oracle_tasks::supervisor_suspend_task`
      : `${tasksPkg}::oracle_tasks::suspend_task_by_owner`;
    tx.moveCall({
      target,
      arguments: input.useSupervisor
        ? [tx.object(registryId), tx.object(input.controllerCapId!), tx.object(input.taskId)]
        : [tx.object(registryId), tx.object(input.taskId)],
    });
    return { tx, target };
  }

  if (input.action === "reactivate") {
    const target = input.useSupervisor
      ? `${tasksPkg}::oracle_tasks::reactivate_task_by_cap`
      : `${tasksPkg}::oracle_tasks::reactivate_task_by_owner`;
    tx.moveCall({
      target,
      arguments: input.useSupervisor
        ? [tx.object(registryId), tx.object(input.controllerCapId!), tx.object(input.taskId), tx.object(clockId)]
        : [tx.object(registryId), tx.object(input.taskId), tx.object(clockId)],
    });
    return { tx, target };
  }

  if (input.action === "delete") {
    const target = input.useSupervisor
      ? `${tasksPkg}::oracle_tasks::delete_task_by_supervisor`
      : input.ownerCapId
        ? `${tasksPkg}::oracle_tasks::delete_task_by_owner_cap`
        : `${tasksPkg}::oracle_tasks::delete_task_by_owner`;
    tx.moveCall({
      target,
      arguments: input.useSupervisor
        ? [tx.object(registryId), tx.object(input.controllerCapId!), tx.object(input.taskId)]
        : input.ownerCapId
          ? [tx.object(registryId), tx.object(input.ownerCapId), tx.object(input.taskId)]
          : [tx.object(registryId), tx.object(input.taskId)],
    });
    return { tx, target };
  }

  if (input.action === "fund") {
    const target = `${tasksPkg}::oracle_tasks::top_up_task`;
    const [fundingCoin] = tx.splitCoins(tx.gas, [tx.pure(bcsU64(input.amount!))]);
    tx.moveCall({
      target,
      arguments: [tx.object(registryId), tx.object(input.taskId), fundingCoin, tx.object(clockId)],
    });
    return { tx, target };
  }

  throw new Error(`Unsupported scheduled task action: ${input.action}`);
}

function isSignatureMismatchError(error: unknown): boolean {
  const msg = String((error as any)?.message ?? error ?? "").toLowerCase();
  if (!msg) return false;
  return [
    "expected ",
    "but got",
    "could not resolve function",
    "unused value without drop",
    "argument",
    "arity",
    "type mismatch",
    "wrong number of arguments",
    "unable to process transaction. could not serialize argument",
  ].some((needle) => msg.includes(needle));
}

function devInspectLooksSuccessful(res: any): boolean {
  const err = String(res?.error ?? "").trim();
  if (err) return false;

  const status = String(res?.effects?.status?.status ?? res?.effects?.status ?? "").toLowerCase();
  if (status && status !== "success") return false;

  const effectsErr = String(res?.effects?.status?.error ?? "").trim();
  if (effectsErr) return false;

  return true;
}

async function pickCreateTaskVariant(
  client: AnyClient,
  sender: string,
  builders: Record<string, () => Transaction>,
): Promise<string[]> {
  const names = Object.keys(builders);

  const inspect = (client as any).devInspectTransactionBlock;
  if (typeof inspect !== "function") return names;

  const winners: string[] = [];
  for (const name of names) {
    try {
      const res = await inspect.call(client, { sender, transactionBlock: builders[name]() });
      if (devInspectLooksSuccessful(res)) winners.push(name);
    } catch {
      // ignore and keep scanning
    }
  }

  return winners.length > 0 ? [...winners, ...names.filter((n) => !winners.includes(n))] : names;
}

async function executeCreateTask(
  client: AnyClient,
  signer: any,
  sender: string,
  builders: Record<string, () => Transaction>,
): Promise<{ res: any; variant: string }> {
  const orderedNames = await pickCreateTaskVariant(client, sender, builders);
  let lastError: unknown;

  for (let i = 0; i < orderedNames.length; i += 1) {
    const variant = orderedNames[i];
    try {
      console.log(`[client] create_task variant=${variant}`);
      const rawRes = await signAndExecuteWithLockRetry({
        client,
        signer,
        transactionFactory: builders[variant],
        options: { showEffects: true, showEvents: true, showObjectChanges: true },
        label: `create_task:${variant}`,
      });
      const res = await hydrateExecutedTransaction(client, rawRes);
      requireSuccessfulTransaction(res);
      return { res, variant };
    } catch (error) {
      lastError = error;
      if (!isSignatureMismatchError(error) || i === orderedNames.length - 1) throw error;
      console.warn(
        `[client] create_task variant ${variant} rejected, trying next: ${String((error as any)?.message ?? error)}`,
      );
    }
  }

  throw lastError;
}

async function serializeTransactionForWallet(tx: Transaction, client: AnyClient): Promise<string> {
  return tx.serialize();
}

async function prepareCreateTaskPlan(client: AnyClient, sender: string, taskArg?: string) {
  return prepareCreateTaskPlanWithOptions(client, sender, taskArg, { skipBalanceCheck: false });
}

async function prepareCreateTaskPlanWithOptions(
  client: AnyClient,
  sender: string,
  taskArg: string | undefined,
  options: { skipBalanceCheck: boolean },
) {
  const tasksPkg = getTasksPackageId();
  const systemPkg = getSystemPackageId();
  const registryId = getTaskRegistryId();
  const stateId = getStateId();
  const nodeRegistryId = await resolveNodeRegistryId(client, stateId);
  const iotaSystemStateId = getIotaSystemStateId();
  const treasuryId = getTreasuryId();
  const randomId = (process.env.IOTA_RANDOM_OBJECT_ID ?? "0x8").trim() || "0x8";
  const clockId = (process.env.IOTA_CLOCK_OBJECT_ID ?? process.env.IOTA_CLOCK_ID ?? "0x6").trim() || "0x6";

  const taskObj = loadTaskJson(taskArg);
  const prepared = normalizeTaskPayload(taskObj);
  const gasBudget = asBigInt(process.env.GAS_BUDGET ?? "50000000", 50_000_000n);
  const template = await getTaskTemplateById(client, stateId, systemPkg, prepared.templateId);
  if (!template) {
    throw new Error(`Template ${prepared.templateId} not found under state ${stateId}`);
  }

  if (prepared.taskType === "STORAGE" && prepared.declaredDownloadBytes <= 0n) {
    const detectedSize = await probeStorageContentLength(prepared.payloadJson);
    prepared.declaredDownloadBytes = detectedSize;
    prepared.payloadJson.declared_download_bytes = detectedSize.toString();
    prepared.payloadText = JSON.stringify(prepared.payloadJson);
  }

  const economics = await getStateEconomics(client, stateId);
  const { rawPrice, systemFee, totalPrice, requiredPayment, requiredPerRun, downloadPrice, extraDownloadBytes } =
    validateAgainstTemplate(
    prepared,
    template,
    economics,
  );
  const balance = await fetchIotaBalance(client, sender);
  const treasuryBalanceBefore = await fetchTreasuryBalance(client, treasuryId, systemPkg);
  const needed = requiredPayment + gasBudget;
  if (!options.skipBalanceCheck && balance < needed) {
    throw new Error(
      `Insufficient IOTA for address ${sender}: balance=${balance.toString()} required_payment=${requiredPayment.toString()} gas_budget=${gasBudget.toString()} total_needed=${needed.toString()}`,
    );
  }

  const builders = buildCreateTaskVariants({
    tasksPkg,
    registryId,
    stateId,
    nodeRegistryId,
    iotaSystemStateId,
    treasuryId,
    randomId,
    clockId,
    prepared,
    requiredPayment,
    requiredPerRun,
    gasBudget,
    fundingSource: await chooseFundingSource(client, sender, requiredPayment, gasBudget),
  });

  return {
    tasksPkg,
    registryId,
    systemPkg,
    stateId,
    nodeRegistryId,
    iotaSystemStateId,
    treasuryId,
    randomId,
    clockId,
    prepared,
    gasBudget,
    template,
    economics,
    rawPrice,
    systemFee,
    totalPrice,
    requiredPayment,
    requiredPerRun,
    downloadPrice,
    extraDownloadBytes,
    balance,
    treasuryBalanceBefore,
    builders,
  };
}

async function runPrepareTaskScheduleWebview(
  taskArg: string | undefined,
  scheduleArg: string | undefined,
  sender: string | undefined,
) {
  const normalizedSender = String(sender ?? "").trim();
  if (!normalizedSender) {
    throw new Error(
      "Usage: npm run create -- prepare-task-schedule-webview <task.json | inline-json> <schedule.json | inline-json> <sender-address>",
    );
  }

  const client = iotaClient() as AnyClient;
  const plan = await prepareCreateTaskPlanWithOptions(client, normalizedSender, taskArg, { skipBalanceCheck: true });
  const schedule = normalizeScheduleInput(
    loadJsonArg(
      scheduleArg,
      "Usage: npm run create -- prepare-task-schedule-webview <task.json | inline-json> <schedule.json | inline-json> <sender-address>",
    ),
  );

  const tasksPkg = getTasksPackageId();
  const registryId = getTaskRegistryId();
  const recurringSchedule = isRecurringSchedule(schedule);
  const fundingAmount = recurringSchedule ? schedule.initialFunds : plan.requiredPayment;
  const txPlan = makeCreateTaskForScheduleInputTx({
    tasksPkg,
    registryId,
    stateId: plan.stateId,
    nodeRegistryId: plan.nodeRegistryId,
    treasuryId: plan.treasuryId,
    randomId: plan.randomId,
    clockId: plan.clockId,
    prepared: plan.prepared,
    requiredPayment: plan.requiredPayment,
    schedule,
    gasBudget: plan.gasBudget,
    fundingSource: await chooseFundingSource(client, normalizedSender, fundingAmount, plan.gasBudget),
  });
  const tx = txPlan.tx;
  tx.setSender(normalizedSender);

  const estimatedRuns = estimateScheduleRuns(schedule);

  const payload: PreparedTaskScheduleWalletTransaction = {
    ok: true,
    mode: "prepare-task-schedule-webview",
    executionMode: txPlan.executionMode,
    sender: normalizedSender,
    serializedTransaction: await serializeTransactionForWallet(tx, client),
    gasBudget: plan.gasBudget.toString(),
    initialFunds: fundingAmount.toString(),
    requiredPayment: plan.requiredPayment.toString(),
    requiredPerRun: plan.requiredPerRun.toString(),
    estimatedRuns,
    targetFunction: txPlan.targetFunction,
    template: {
      templateId: plan.template.templateId,
      taskType: plan.template.taskType,
    },
    schedule: {
      startScheduleMs: schedule.startScheduleMs.toString(),
      endScheduleMs: schedule.endScheduleMs.toString(),
      intervalMs: schedule.intervalMs.toString(),
    },
    prepared: {
      templateId: plan.prepared.templateId,
      taskType: plan.prepared.taskType,
      requestedNodes: plan.prepared.requestedNodes,
      quorumK: plan.prepared.quorumK,
      retentionDays: plan.prepared.retentionDays,
      declaredDownloadBytes: plan.prepared.declaredDownloadBytes.toString(),
      mediationMode: plan.prepared.mediationMode,
      varianceMax: plan.prepared.varianceMax,
      createResultControllerCap: plan.prepared.createResultControllerCap,
      storageSourceUrl: plan.prepared.storageSourceUrl,
      payloadJson: plan.prepared.payloadJson,
    },
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function runPrepareScheduledTaskActionWebview(
  actionArg: string | undefined,
  sender: string | undefined,
) {
  const normalizedSender = String(sender ?? "").trim();
  if (!normalizedSender) {
    throw new Error(
      "Usage: npm run create -- prepare-scheduled-task-action-webview <action.json | inline-json> <sender-address>",
    );
  }

  const actionInput = normalizeScheduledTaskActionInput(
    loadJsonArg(
      actionArg,
      "Usage: npm run create -- prepare-scheduled-task-action-webview <action.json | inline-json> <sender-address>",
    ),
  );

  const txPlan = makeScheduledTaskActionTx({
    tasksPkg: getTasksPackageId(),
    registryId: getTaskRegistryId(),
    clockId: envAny("IOTA_CLOCK_OBJECT_ID", "IOTA_CLOCK_ID") ?? "0x6",
    gasBudget: asBigInt(process.env.GAS_BUDGET ?? "50000000", 50_000_000n),
    input: actionInput,
  });
  txPlan.tx.setSender(normalizedSender);

  const payload: PreparedScheduledTaskActionWalletTransaction = {
    ok: true,
    mode: "prepare-scheduled-task-action-webview",
    sender: normalizedSender,
    action: actionInput.action,
    taskId: actionInput.taskId,
    serializedTransaction: await serializeTransactionForWallet(txPlan.tx, iotaClient() as AnyClient),
    gasBudget: String(asBigInt(process.env.GAS_BUDGET ?? "50000000", 50_000_000n)),
    amount: actionInput.amount == null ? null : actionInput.amount.toString(),
    useSupervisor: actionInput.useSupervisor === true,
    controllerCapId: actionInput.controllerCapId ?? null,
    ownerCapId: actionInput.ownerCapId ?? null,
    target: txPlan.target,
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function runPrepareWebview(taskArg: string | undefined, sender: string | undefined) {
  const normalizedSender = String(sender ?? "").trim();
  if (!normalizedSender) {
    throw new Error("Usage: npm run create -- prepare-webview <task.json | inline-json> <sender-address>");
  }

  const client = iotaClient() as AnyClient;
  const plan = await prepareCreateTaskPlanWithOptions(client, normalizedSender, taskArg, { skipBalanceCheck: true });
  const orderedNames = await pickCreateTaskVariant(client, normalizedSender, plan.builders);
  const variant = orderedNames[0];
  if (!variant) throw new Error("Unable to determine a create_task variant for webview preparation");

  const tx = plan.builders[variant]();
  tx.setSender(normalizedSender);

  const payload: PreparedWalletTransaction = {
    ok: true,
    mode: "prepare-webview",
    sender: normalizedSender,
    variant,
    serializedTransaction: await serializeTransactionForWallet(tx, client),
    gasBudget: plan.gasBudget.toString(),
    requiredPayment: plan.requiredPayment.toString(),
    requiredPerRun: plan.requiredPerRun.toString(),
    rawPrice: plan.rawPrice.toString(),
    systemFee: plan.systemFee.toString(),
    totalPrice: plan.totalPrice.toString(),
    downloadPrice: plan.downloadPrice.toString(),
    extraDownloadBytes: plan.extraDownloadBytes.toString(),
    balance: plan.balance.toString(),
    treasuryBalanceBefore: plan.treasuryBalanceBefore == null ? null : plan.treasuryBalanceBefore.toString(),
    template: {
      templateId: plan.template.templateId,
      taskType: plan.template.taskType,
    },
    prepared: {
      templateId: plan.prepared.templateId,
      taskType: plan.prepared.taskType,
      requestedNodes: plan.prepared.requestedNodes,
      quorumK: plan.prepared.quorumK,
      retentionDays: plan.prepared.retentionDays,
      declaredDownloadBytes: plan.prepared.declaredDownloadBytes.toString(),
      mediationMode: plan.prepared.mediationMode,
      varianceMax: plan.prepared.varianceMax,
      createResultControllerCap: plan.prepared.createResultControllerCap,
      storageSourceUrl: plan.prepared.storageSourceUrl,
      payloadJson: plan.prepared.payloadJson,
    },
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function runCliCreate(taskArg?: string) {
  const client = iotaClient() as AnyClient;
  const id = loadOrCreateClientIdentity();

  console.log(`[client] address=${id.address}`);
  await requestFaucetIfEnabled(id.address);

  const plan = await prepareCreateTaskPlan(client, id.address, taskArg);

  console.log(
    `[client] template=${plan.template.templateId} template_task_type=${plan.template.taskType || "<empty>"} requested_type=${plan.prepared.taskType} treasury=${plan.treasuryId}`,
  );
  console.log(
    `[client] price raw=${plan.rawPrice.toString()} download_price=${plan.downloadPrice.toString()} extra_download_bytes=${plan.extraDownloadBytes.toString()} min_payment=${plan.economics.minPayment.toString()} required=${plan.requiredPayment.toString()} retention_days=${plan.prepared.retentionDays} declared_download_bytes=${plan.prepared.declaredDownloadBytes.toString()}`,
  );

  const needed = plan.requiredPayment + plan.gasBudget;
  console.log(`[client] balance=${plan.balance.toString()} need_at_least=${needed.toString()} (payment + gas_budget)`);
  if (plan.treasuryBalanceBefore != null)
    console.log(`[client] treasury balance before=${plan.treasuryBalanceBefore.toString()}`);

  const { res, variant } = await executeCreateTask(client, id.keypair, id.address, plan.builders);
  console.log(`[client] digest ${res.digest}`);
  console.log(`[client] create_task chosen variant ${variant}`);
  const txStatus = getTxStatusInfo(res);
  if (txStatus.status) {
    console.log(`[client] tx_status=${txStatus.status}${txStatus.error ? ` error=${txStatus.error}` : ""}`);
  }

  const treasuryBalanceAfter = await fetchTreasuryBalance(client, plan.treasuryId, plan.systemPkg);
  if (treasuryBalanceAfter != null)
    console.log(
      `[client] treasury balance after=${treasuryBalanceAfter.toString()} delta=${plan.treasuryBalanceBefore == null ? "?" : (treasuryBalanceAfter - plan.treasuryBalanceBefore).toString()}`,
    );

  const taskId = extractTaskIdFromTx(res);
  if (!taskId) {
    console.warn("[client] could not determine task_id from tx (events/objectChanges)");
    return;
  }

  console.log(`[client] task_id ${taskId}`);

  if (await isTaskFinalized(client, taskId)) {
    console.log("[client] task already finalized (result present), skipping wait");
  } else {
    console.log("[client] waiting terminal state...");
    const done = await waitTaskCompletedOrResult({ client, taskId });
    console.log(`[client] terminal: ${done.kind} state=${done.state}`);
  }

  const snapshot = await readTaskCompositeState(client, taskId);
  const taskFields = snapshot.taskFields;
  const latestResultFields = snapshot.latestResult?.fields ?? {};
  const mediationMeta = readTaskMediationMeta(snapshot);

  console.log(`task_available_balance_iota: ${String(taskFields.available_balance_iota?.value ?? taskFields.available_balance_iota ?? "0")}`);
  console.log(`task_template_id: ${String(taskFields.template_id ?? "0")}`);
  console.log(`task_retention_days: ${String(taskFields.retention_days ?? "0")}`);
  console.log(`task_declared_download_bytes: ${String(taskFields.declared_download_bytes ?? "0")}`);
  console.log(`task_mediation_mode: ${String(mediationMeta.mediationMode)}`);
  console.log(`task_variance_max: ${String(taskFields.variance_max ?? "0")}`);
  console.log(`task_mediation_attempts: ${String(mediationMeta.mediationAttempts)}`);
  console.log(`task_mediation_status: ${String(mediationMeta.mediationStatus)}`);
  console.log(`task_mediation_variance: ${String(mediationMeta.mediationVariance)}`);
  const resultBytes = decodeVecU8(latestResultFields.result);
  const multisigBytes = decodeVecU8(latestResultFields.multisig_bytes);
  const multisigAddr = String(latestResultFields.multisig_addr ?? "");
  const latestResultSeq = snapshot.latestResult?.seq?.toString() ?? "0";

  console.log("--- TASK RESULT ---");
  console.log("latest_result_seq:", latestResultSeq);
  console.log("result_reason_code:", String(latestResultFields.reason_code ?? "0"));
  console.log("multisig_addr:", multisigAddr);
  console.log("multisig_bytes_b64:", Buffer.from(multisigBytes).toString("base64"));
  console.log("result_utf8 (first 4000 chars):\n", new TextDecoder().decode(resultBytes).slice(0, 4000));
}

async function main() {
  const mode = String(process.argv[2] ?? "").trim();
  if (mode === "prepare-webview") {
    await runPrepareWebview(process.argv[3], process.argv[4]);
    return;
  }

  if (mode === "prepare-task-schedule-webview") {
    await runPrepareTaskScheduleWebview(process.argv[3], process.argv[4], process.argv[5]);
    return;
  }

  if (mode === "prepare-scheduled-task-action-webview") {
    await runPrepareScheduledTaskActionWebview(process.argv[3], process.argv[4]);
    return;
  }

  await runCliCreate(process.argv[2]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
