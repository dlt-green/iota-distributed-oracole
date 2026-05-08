// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { IotaClient } from "@iota/iota-sdk/client";
import {
  config,
  envDebug,
  getActiveNetwork,
  getRuntimeConfig,
  getSupportedNetworks,
  setActiveNetwork,
  type OracleNetwork,
} from "./config.js";
import {
  executeOracleTask,
  listExampleTasks,
  prepareOracleTaskScheduleForWallet,
  prepareScheduledTaskActionForWallet,
  prepareOracleTaskForWallet,
  readExampleTask,
} from "./services/oracleClient.js";
import { getIotaMarketPrice } from "./services/marketData.js";
import {
  prepareNodeManagementForWallet,
  prepareProposalApprovalForWallet,
} from "./services/nodeManagement.js";
import { getOracleStatus } from "./services/oracleStatus.js";
import { getTaskSchedules } from "./services/taskSchedules.js";

const app = express();

app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self';");
  next();
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));

function sendApiError(res: express.Response, status: number, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  res.status(status).json({ error: message });
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function extractFields(value: unknown): Record<string, any> | null {
  const record = asRecord(value);
  if (!record) return null;

  const fields = asRecord(record.fields);
  if (fields) return fields;

  const data = asRecord(record.data);
  if (data) {
    const nested = extractFields(data);
    if (nested) return nested;
  }

  const content = asRecord(record.content);
  if (content) {
    const nested = extractFields(content);
    if (nested) return nested;
  }

  const nestedValue = asRecord(record.value);
  if (nestedValue) {
    const nested = extractFields(nestedValue);
    if (nested) return nested;
  }

  return null;
}

function normalizeAddress(value: unknown): string {
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return "";
  return s.startsWith("0x") ? s : `0x${s}`;
}

function moveObjectIdToString(value: unknown): string {
  if (typeof value === "string") return value.trim();

  const record = asRecord(value);
  if (!record) return "";

  for (const key of ["id", "objectId", "value"]) {
    if (typeof record[key] === "string") return String(record[key]).trim();
  }

  return "";
}

function extractEventTaskId(value: unknown): string {
  const direct = normalizeAddress(
    moveObjectIdToString(
      asRecord(value)?.task_id ??
        asRecord(value)?.taskId ??
        asRecord(value)?.task ??
        asRecord(asRecord(value)?.task)?.id,
    ),
  );
  if (direct) return direct;

  const record = extractFields(value) ?? asRecord(value);
  if (!record) return "";

  for (const key of ["task_id", "taskId", "task"]) {
    if (!(key in record)) continue;
    const nested = normalizeAddress(moveObjectIdToString(record[key]));
    if (nested) return nested;
    const nestedFields = extractFields(record[key]) ?? asRecord(record[key]);
    if (!nestedFields) continue;
    const nestedId = normalizeAddress(
      moveObjectIdToString(nestedFields.id ?? nestedFields.objectId ?? nestedFields.value),
    );
    if (nestedId) return nestedId;
  }

  return "";
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  const record = asRecord(value);
  if (!record) return null;
  return numberFromUnknown(record.value);
}

function taskCompatState(fields: Record<string, any>): number {
  const directState = numberFromUnknown(fields.state);
  if (directState != null) return directState;
  const executionState = numberFromUnknown(fields.execution_state) ?? -1;
  if (executionState === 1) return 1;
  if (executionState === 2) return 2;
  if (executionState === 9) return 9;
  if (executionState === 10) return 10;
  return 0;
}

function unwrapFieldValue(obj: any): Record<string, any> {
  const nestedValue = asRecord(obj?.data?.content?.fields?.value?.fields);
  if (nestedValue) return nestedValue;
  const value = asRecord(obj?.data?.content?.fields?.value);
  if (value) return value;
  const direct = asRecord(obj?.data?.content?.fields);
  if (direct) return direct;
  const content = asRecord(obj?.data?.content);
  if (content) {
    const nested = asRecord(content.fields);
    if (nested) return nested;
  }
  return {};
}

type TaskResultSummary = {
  objectId: string;
  seq: number;
  produced_at_ms: number;
  run_index: number;
  multisig_addr: unknown;
  multisig_bytes: unknown;
  certificate_blob: unknown;
  certificate_signers: unknown;
  result: unknown;
  result_hash: unknown;
  reason_code: unknown;
  raw: Record<string, any>;
};

type TaskEventSummary = {
  id: unknown;
  type: string | null;
  sender: string | null;
  timestampMs: string | number | null;
  parsedJson: Record<string, unknown> | null;
  module: string;
};

type TaskRunSummary = {
  run_index: number;
  status: "OPEN" | "MEDIATION" | "FINALIZED" | "ABORTED";
  submitted_at_ms: number | null;
  completed_at_ms: number | null;
  produced_at_ms: number | null;
  result_seq: number | null;
  reason_code: number | null;
  signer_count: number | null;
  next_run_ms: number | null;
};

const TASK_STREAM_POLL_MS = 4_000;

async function fetchTaskResults(
  client: IotaClient,
  taskId: string,
  tasksPackageId: string,
): Promise<TaskResultSummary[]> {
  if (!taskId || !tasksPackageId) return [];

  try {
    const page: any = await client.getDynamicFields({
      parentId: taskId,
      limit: 50,
    } as any);

    const candidates = (page?.data ?? []).filter((item: any) => {
      const objectType = String(item?.objectType ?? "");
      const nameType = String(item?.name?.type ?? "");
      return (
        objectType === `${tasksPackageId}::oracle_tasks::TaskResult` ||
        nameType === `${tasksPackageId}::oracle_tasks::TaskResultKey`
      );
    });

    if (!candidates.length) return [];

    const objects = await Promise.all(
      candidates.map(async (item: any) => {
        const objectId = String(item?.objectId ?? "").trim();
        if (!objectId) return null;
        try {
          const obj: any = await client.getObject({
            id: objectId,
            options: { showContent: true, showType: true },
          });
          const fields = unwrapFieldValue(obj);
          return {
            objectId,
            seq: numberFromUnknown(item?.name?.value?.seq) ?? -1,
            producedAtMs: numberFromUnknown(fields.produced_at_ms) ?? -1,
            runIndex: numberFromUnknown(fields.run_index) ?? -1,
            fields,
          };
        } catch {
          return null;
        }
      }),
    );

    return objects
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => {
        if (b.producedAtMs !== a.producedAtMs) return b.producedAtMs - a.producedAtMs;
        if (b.seq !== a.seq) return b.seq - a.seq;
        return b.runIndex - a.runIndex;
      })
      .map((item) => ({
        objectId: item.objectId,
        seq: item.seq,
        produced_at_ms: item.producedAtMs,
        run_index: item.runIndex,
        multisig_addr: item.fields.multisig_addr ?? null,
        multisig_bytes: item.fields.multisig_bytes ?? null,
        certificate_blob: item.fields.certificate_blob ?? null,
        certificate_signers: item.fields.certificate_signers ?? [],
        result: item.fields.result ?? null,
        result_hash: item.fields.result_hash ?? null,
        reason_code: item.fields.reason_code ?? 0,
        raw: item.fields,
      }));
  } catch {
    return [];
  }
}

async function queryTaskEventsByModule(
  client: IotaClient,
  packageId: string,
  moduleName: string,
  taskId: string,
) : Promise<TaskEventSummary[]> {
  if (!packageId || !moduleName) return [];

  const wantedTaskId = normalizeAddress(taskId);
  const out: Array<{
    id: unknown;
    type: string | null;
    sender: string | null;
    timestampMs: string | number | null;
    parsedJson: Record<string, unknown> | null;
    module: string;
  }> = [];

  let cursor: string | null | undefined = null;
  const pageLimit = Math.max(10, Number(config.eventFetchLimit || 100));

  for (let pageNo = 0; pageNo < 20; pageNo += 1) {
    const page: any = await client.queryEvents({
      query: {
        MoveModule: {
          package: packageId,
          module: moduleName,
        },
      },
      cursor,
      limit: pageLimit,
      order: "descending",
    } as any);

    for (const evt of page?.data ?? []) {
      const parsed = (evt?.parsedJson ?? evt?.parsed_json ?? null) as Record<string, unknown> | null;
      const eventTaskId = extractEventTaskId(parsed);

      if (eventTaskId !== wantedTaskId) continue;

      out.push({
        id: evt?.id ?? null,
        type: evt?.type ?? null,
        sender: evt?.sender ?? null,
        timestampMs: evt?.timestampMs ?? null,
        parsedJson: parsed,
        module: evt?.transactionModule ?? moduleName,
      });
    }

    if (!page?.hasNextPage || !page?.nextCursor) break;
    cursor = page.nextCursor;
  }

  return out;
}

function eventTypeName(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const parts = raw.split("::");
  return parts[parts.length - 1] || raw;
}

function buildRunHistory(
  events: TaskEventSummary[],
  results: TaskResultSummary[],
  fields: Record<string, any>,
): TaskRunSummary[] {
  const byRun = new Map<number, TaskRunSummary>();

  function ensure(runIndex: number): TaskRunSummary {
    let current = byRun.get(runIndex);
    if (!current) {
      current = {
        run_index: runIndex,
        status: "OPEN",
        submitted_at_ms: null,
        completed_at_ms: null,
        produced_at_ms: null,
        result_seq: null,
        reason_code: null,
        signer_count: null,
        next_run_ms: null,
      };
      byRun.set(runIndex, current);
    }
    return current;
  }

  for (const result of results) {
    const runIndex = Number(result.run_index ?? -1);
    if (!Number.isFinite(runIndex) || runIndex < 0) continue;
    const current = ensure(runIndex);
    current.status = "FINALIZED";
    current.produced_at_ms = result.produced_at_ms ?? null;
    current.result_seq = result.seq ?? null;
    current.reason_code = Number(result.reason_code ?? 0) || 0;
    current.signer_count = Array.isArray(result.certificate_signers)
      ? result.certificate_signers.length
      : 0;
  }

  for (const evt of events) {
    const parsed = asRecord(evt.parsedJson) ?? {};
    const runIndex = numberFromUnknown(parsed.run_index);
    if (runIndex == null || runIndex < 0) continue;
    const current = ensure(runIndex);
    const timestampMs = numberFromUnknown(evt.timestampMs);
    const typeName = eventTypeName(evt.type);

    if (typeName === "TaskRunSubmitted") {
      current.submitted_at_ms ??= timestampMs;
      current.next_run_ms = numberFromUnknown(parsed.next_run_ms) ?? current.next_run_ms;
      if (current.status !== "FINALIZED" && current.status !== "ABORTED") current.status = "OPEN";
      continue;
    }

    if (typeName === "TaskRunMediationStarted") {
      current.submitted_at_ms ??= timestampMs;
      if (current.status !== "FINALIZED" && current.status !== "ABORTED") current.status = "MEDIATION";
      continue;
    }

    if (typeName === "TaskRunFinalized") {
      current.status = "FINALIZED";
      current.completed_at_ms = timestampMs;
      current.result_seq = numberFromUnknown(parsed.result_seq) ?? current.result_seq;
      current.signer_count = numberFromUnknown(parsed.signer_count) ?? current.signer_count;
      current.next_run_ms = numberFromUnknown(parsed.next_run_ms) ?? current.next_run_ms;
      continue;
    }

    if (typeName === "TaskRunAborted") {
      current.status = "ABORTED";
      current.completed_at_ms = timestampMs;
      current.reason_code = numberFromUnknown(parsed.reason_code) ?? current.reason_code;
      current.result_seq = numberFromUnknown(parsed.result_seq) ?? current.result_seq;
      current.next_run_ms = numberFromUnknown(parsed.next_run_ms) ?? current.next_run_ms;
    }
  }

  const activeRunIndex = numberFromUnknown(fields.active_run_index) ?? -1;
  const latestResultSeq = numberFromUnknown(fields.latest_result_seq) ?? -1;
  const executionState = numberFromUnknown(fields.execution_state) ?? -1;
  if (executionState === 1 && activeRunIndex > latestResultSeq && activeRunIndex >= 0) {
    const current = ensure(activeRunIndex);
    if (current.status !== "FINALIZED" && current.status !== "ABORTED") {
      current.status = current.status === "MEDIATION" ? "MEDIATION" : "OPEN";
    }
  }

  return [...byRun.values()].sort((a, b) => b.run_index - a.run_index);
}

function pickFirst(...values: unknown[]) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function collectArrayItems(value: any, out: any[]): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectArrayItems(item, out);
    return;
  }
  if (typeof value !== "object") {
    out.push(value);
    return;
  }

  const record = value as Record<string, any>;
  const nestedFields = asRecord(record.fields);
  if (nestedFields && nestedFields !== record) collectArrayItems(nestedFields, out);

  for (const key of ["items", "contents", "vec", "value", "fields", "data"]) {
    if (key in record) collectArrayItems(record[key], out);
  }
}

function nestedArray(value: any): any[] {
  const out: any[] = [];
  collectArrayItems(value, out);
  return out;
}

function nestedTextArray(value: any): string[] {
  const out: string[] = [];
  for (const item of nestedArray(value)) {
    const normalized = normalizeAddress(moveObjectIdToString(item) || String(item ?? ""));
    if (normalized) out.push(normalized);
  }
  return out.filter((item, index) => out.indexOf(item) === index);
}

async function fetchTaskSnapshot(taskId: string, network?: OracleNetwork) {
  const runtime = getRuntimeConfig(network);
  const client = new IotaClient({ url: runtime.rpcUrl });

  const response = await client.getObject({
    id: taskId,
    options: {
      showType: true,
      showOwner: true,
      showContent: true,
      showDisplay: true,
    },
  });

  const data = response?.data as any;
  if (!data) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const fields = extractFields(data.content) ?? {};
  const taskType = String(data.type ?? "");
  const taskPackageId = taskType.split("::")[0] || runtime.oracleTasksPackageId || "";
  const latestResultSeq = numberFromUnknown(fields.latest_result_seq) ?? 0;
  const results =
    latestResultSeq > 0 && runtime.oracleTasksPackageId
      ? await fetchTaskResults(client, taskId, runtime.oracleTasksPackageId)
      : [];
  const [taskEvents, messageEvents] = taskPackageId
    ? await Promise.all([
        queryTaskEventsByModule(client, taskPackageId, config.oracleTaskModule, taskId).catch(() => []),
        queryTaskEventsByModule(client, taskPackageId, config.oracleMessageModule, taskId).catch(() => []),
      ])
    : [[], []];
  const allEvents = [...taskEvents, ...messageEvents].sort(
    (a, b) => Number(a.timestampMs ?? 0) - Number(b.timestampMs ?? 0),
  );
  const run_history = buildRunHistory(allEvents, results, fields);
  const latestResultFields = results[0]?.raw ?? {};

  const task = {
    objectId: data.objectId,
    version: data.version,
    digest: data.digest,
    type: data.type,
    owner: data.owner ?? null,
    task_id: data.objectId,
    template_id: pickFirst(fields.template_id, fields.config?.fields?.template_id),
    assigned_nodes: nestedTextArray(
      pickFirst(fields.assigned_nodes, fields.runtime?.fields?.assigned_nodes, fields.consensus?.fields?.assigned_nodes),
    ),
    status: pickFirst(fields.status, fields.runtime?.fields?.status),
    execution_state: pickFirst(fields.execution_state, fields.runtime?.fields?.execution_state),
    active_round: pickFirst(fields.active_round, fields.runtime?.fields?.active_round),
    state: taskCompatState(fields),
    quorum_k: Number(
      pickFirst(fields.quorum_k, fields.config?.fields?.quorum_k, fields.consensus?.fields?.quorum_k, 0),
    ),
    multisig_addr: pickFirst(latestResultFields.multisig_addr, fields.multisig_addr, fields.certificate?.fields?.multisig_addr),
    multisig_bytes: pickFirst(latestResultFields.multisig_bytes, fields.multisig_bytes, fields.certificate?.fields?.multisig_bytes),
    certificate_blob: pickFirst(
      latestResultFields.certificate_blob,
      fields.certificate_blob,
      fields.certificate?.fields?.certificate_blob,
    ),
    certificate_signers: nestedTextArray(
      pickFirst(latestResultFields.certificate_signers, fields.certificate_signers, fields.certificate?.fields?.certificate_signers),
    ),
    result: pickFirst(latestResultFields.result, fields.result, fields.runtime?.fields?.result),
    result_hash: pickFirst(latestResultFields.result_hash, fields.result_hash, fields.runtime?.fields?.result_hash),
    result_bytes: pickFirst(
      latestResultFields.result,
      latestResultFields.result_bytes,
      fields.result_bytes,
      fields.runtime?.fields?.result_bytes,
    ),
    reason_code: pickFirst(latestResultFields.reason_code, 0),
    latest_result_seq: pickFirst(fields.latest_result_seq, fields.runtime?.fields?.latest_result_seq),
    result_order: nestedArray(pickFirst(fields.result_order, fields.runtime?.fields?.result_order)),
    latest_result: latestResultFields,
    results,
    run_history,
    raw: fields,
  };

  return {
    taskId,
    packageId: taskPackageId,
    task,
    events: allEvents,
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "iota_oracle_webview", time: new Date().toISOString() });
});

app.get("/api/status", async (req, res) => {
  try {
    const network = typeof req.query.network === "string" ? req.query.network : undefined;
    const status = await getOracleStatus(network as OracleNetwork | undefined);
    res.json(status);
  } catch (error) {
    sendApiError(res, 500, error);
  }
});

app.get("/api/task-schedules", async (req, res) => {
  try {
    const network = typeof req.query.network === "string" ? req.query.network : undefined;
    const data = await getTaskSchedules(network as OracleNetwork | undefined);
    res.json(data);
  } catch (error) {
    sendApiError(res, 500, error);
  }
});

app.get("/api/network", (req, res) => {
  const requested = typeof req.query.network === "string" ? req.query.network : undefined;
  const runtime = getRuntimeConfig(requested as OracleNetwork | undefined);
  res.json({
    activeNetwork: requested ? runtime.network : getActiveNetwork(),
    supportedNetworks: getSupportedNetworks(),
    rpcUrl: runtime.rpcUrl,
    tasksPackageId: runtime.oracleTasksPackageId || null,
    systemPackageId: runtime.oracleSystemPackageId || null,
    stateId: runtime.oracleStateId || null,
  });
});

app.post("/api/network", (req, res) => {
  try {
    const network = String((req.body as any)?.network ?? "").trim();
    if (!network) {
      res.status(400).json({ error: "Body must include network." });
      return;
    }
    const activeNetwork = setActiveNetwork(network);
    const runtime = getRuntimeConfig(activeNetwork);
    res.json({
      ok: true,
      activeNetwork,
      supportedNetworks: getSupportedNetworks(),
      rpcUrl: runtime.rpcUrl,
      tasksPackageId: runtime.oracleTasksPackageId || null,
      systemPackageId: runtime.oracleSystemPackageId || null,
      stateId: runtime.oracleStateId || null,
    });
  } catch (error) {
    sendApiError(res, 400, error);
  }
});

app.get("/api/examples", async (_req, res) => {
  try {
    const items = await listExampleTasks();
    res.json(items);
  } catch (error) {
    sendApiError(res, 500, error);
  }
});

app.get("/api/examples/:name", async (req, res) => {
  try {
    const item = await readExampleTask(req.params.name);
    res.json(item);
  } catch (error) {
    sendApiError(res, 404, error);
  }
});

app.get("/api/market/iota-price", async (_req, res) => {
  try {
    const price = await getIotaMarketPrice();
    res.json(price);
  } catch (error) {
    sendApiError(res, 502, error);
  }
});

app.get("/api/task/:taskId", async (req, res) => {
  try {
    const taskId = String(req.params.taskId ?? "").trim();
    const network = typeof req.query.network === "string" ? req.query.network : undefined;
    if (!taskId) {
      res.status(400).json({ error: "Missing taskId" });
      return;
    }

    const snapshot = await fetchTaskSnapshot(taskId, network as OracleNetwork | undefined);
    res.json(snapshot.task);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Task not found:")) {
      sendApiError(res, 404, error);
      return;
    }
    sendApiError(res, 500, error);
  }
});

app.get("/api/task/:taskId/events", async (req, res) => {
  try {
    const taskId = String(req.params.taskId ?? "").trim();
    const network = typeof req.query.network === "string" ? req.query.network : undefined;
    if (!taskId) {
      res.status(400).json({ error: "Missing taskId" });
      return;
    }

    const snapshot = await fetchTaskSnapshot(taskId, network as OracleNetwork | undefined);
    res.json({
      taskId,
      packageId: snapshot.packageId,
      events: snapshot.events,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Task not found:")) {
      sendApiError(res, 404, error);
      return;
    }
    sendApiError(res, 500, error);
  }
});

app.get("/api/task/:taskId/stream", async (req, res) => {
  const taskId = String(req.params.taskId ?? "").trim();
  const network = typeof req.query.network === "string" ? req.query.network : undefined;

  if (!taskId) {
    res.status(400).json({ error: "Missing taskId" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  let lastSnapshotSignature = "";

  const sendEvent = (eventName: string, payload: unknown) => {
    if (closed) return;
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const scheduleNextPoll = () => {
    if (closed) return;
    timer = setTimeout(() => {
      void pollSnapshot();
    }, TASK_STREAM_POLL_MS);
  };

  const pollSnapshot = async () => {
    try {
      const snapshot = await fetchTaskSnapshot(taskId, network as OracleNetwork | undefined);
      const signature = JSON.stringify(snapshot);

      if (signature !== lastSnapshotSignature) {
        lastSnapshotSignature = signature;
        sendEvent("snapshot", snapshot);
      } else {
        res.write(": keep-alive\n\n");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendEvent("error", { error: message });
    } finally {
      scheduleNextPoll();
    }
  };

  sendEvent("ready", { ok: true, taskId, network: network ?? getActiveNetwork() });
  void pollSnapshot();

  req.on("close", () => {
    closed = true;
    if (timer) clearTimeout(timer);
    res.end();
  });
});

app.post("/api/tasks/prepare-wallet", async (req, res) => {
  try {
    if (typeof req.body !== "object" || req.body === null || !("task" in req.body)) {
      res.status(400).json({ error: 'Body must be { "task": ..., "sender": "0x..." }.' });
      return;
    }

    const sender = typeof req.body.sender === "string" ? req.body.sender.trim() : "";
    if (!sender) {
      res.status(400).json({ error: "Body must include sender as a wallet address." });
      return;
    }

    const network = typeof (req.body as any).network === "string" ? (req.body as any).network.trim() : "";
    const result = await prepareOracleTaskForWallet(
      (req.body as any).task,
      sender,
      network ? setActiveNetwork(network) : undefined,
    );
    res.json(result);
  } catch (error) {
    sendApiError(res, 500, error);
  }
});

app.post("/api/tasks/prepare-task-schedule-wallet", async (req, res) => {
  try {
    const task = (req.body as any)?.task;
    const schedule = (req.body as any)?.schedule;
    const sender = String((req.body as any)?.sender ?? "").trim();
    const network = typeof (req.body as any)?.network === "string" ? (req.body as any).network : undefined;
    if (!sender) {
      res.status(400).json({ error: "Body must include sender." });
      return;
    }
    if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
      res.status(400).json({ error: "Body must include schedule object." });
      return;
    }
    const prepared = await prepareOracleTaskScheduleForWallet(task, schedule, sender, network);
    res.json(prepared);
  } catch (error) {
    sendApiError(res, 400, error);
  }
});

app.post("/api/task-schedules/prepare-action-wallet", async (req, res) => {
  try {
    const action = (req.body as any)?.action;
    const sender = String((req.body as any)?.sender ?? "").trim();
    const network = typeof (req.body as any)?.network === "string" ? (req.body as any).network : undefined;
    if (!sender) {
      res.status(400).json({ error: "Body must include sender." });
      return;
    }
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      res.status(400).json({ error: "Body must include action object." });
      return;
    }
    const prepared = await prepareScheduledTaskActionForWallet(action, sender, network);
    res.json(prepared);
  } catch (error) {
    sendApiError(res, 400, error);
  }
});

app.post("/api/node-management/prepare-wallet", async (req, res) => {
  try {
    const sender = String((req.body as any)?.sender ?? "").trim();
    const network = typeof (req.body as any)?.network === "string" ? (req.body as any).network : undefined;
    const acceptedTemplateIdsRaw = Array.isArray((req.body as any)?.acceptedTemplateIds)
      ? (req.body as any).acceptedTemplateIds
      : null;
    if (!sender) {
      res.status(400).json({ error: "Body must include sender." });
      return;
    }
    if (!acceptedTemplateIdsRaw) {
      res.status(400).json({ error: "Body must include acceptedTemplateIds array." });
      return;
    }
    const acceptedTemplateIds = acceptedTemplateIdsRaw
      .map((item: unknown) => Number(item))
      .filter((item: number) => Number.isFinite(item) && item >= 0)
      .map((item: number) => Math.floor(item));
    const prepared = await prepareNodeManagementForWallet(sender, acceptedTemplateIds, network);
    res.json(prepared);
  } catch (error) {
    sendApiError(res, 400, error);
  }
});

app.post("/api/node-management/prepare-approve-wallet", async (req, res) => {
  try {
    const sender = String((req.body as any)?.sender ?? "").trim();
    const network = typeof (req.body as any)?.network === "string" ? (req.body as any).network : undefined;
    const proposalId = Number((req.body as any)?.proposalId);
    const templateId = Number((req.body as any)?.templateId);
    if (!sender) {
      res.status(400).json({ error: "Body must include sender." });
      return;
    }
    if (!Number.isFinite(proposalId) || proposalId <= 0) {
      res.status(400).json({ error: "Body must include a valid proposalId." });
      return;
    }
    if (!Number.isFinite(templateId) || templateId < 0) {
      res.status(400).json({ error: "Body must include a valid templateId." });
      return;
    }
    const prepared = await prepareProposalApprovalForWallet(
      sender,
      Math.floor(proposalId),
      Math.floor(templateId),
      network,
    );
    res.json(prepared);
  } catch (error) {
    sendApiError(res, 400, error);
  }
});

app.post("/api/tasks/execute", async (req, res) => {
  try {
    if (typeof req.body !== "object" || req.body === null || !("task" in req.body)) {
      res.status(400).json({ error: 'Body must be { "task": ... }.' });
      return;
    }

    const network = typeof (req.body as any).network === "string" ? (req.body as any).network.trim() : "";
    const result = await executeOracleTask((req.body as any).task, network ? setActiveNetwork(network) : undefined);
    res.status(result.ok ? 200 : 500).json(result);
  } catch (error) {
    sendApiError(res, 500, error);
  }
});

const distPath = path.resolve(process.cwd(), "dist");
const indexPath = path.join(distPath, "index.html");

function verifyBuiltAssets() {
  const indexHtml = fs.readFileSync(indexPath, "utf8");
  const assetRefs = [...indexHtml.matchAll(/(?:src|href)="\/([^"?#]+)"/g)]
    .map((match) => match[1])
    .filter((assetPath) => assetPath.startsWith("assets/"));
  const missingAssets = assetRefs.filter((assetPath) => !fs.existsSync(path.join(distPath, assetPath)));

  if (missingAssets.length) {
    throw new Error(`Webview build is missing asset(s): ${missingAssets.join(", ")}`);
  }

  return assetRefs;
}

const builtAssetRefs = verifyBuiltAssets();

app.use(
  express.static(distPath, {
    setHeaders(res, filePath) {
      const normalizedPath = filePath.replace(/\\/g, "/");
      if (normalizedPath.endsWith("/index.html")) {
        res.setHeader("Cache-Control", "no-cache");
        return;
      }
      if (normalizedPath.includes("/assets/")) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }),
);

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ error: `API route not found: ${req.path}` });
    return;
  }

  if (path.extname(req.path)) {
    res.status(404).type("text/plain").send(`Static asset not found: ${req.path}`);
    return;
  }

  res.sendFile(indexPath);
});

app.listen(config.port, "0.0.0.0", () => {
  const runtime = getRuntimeConfig();
  console.log(`[iota_oracle_webview] listening on http://0.0.0.0:${config.port}`);
  console.log(`[iota_oracle_webview] client dir: ${config.oracleClientDir}`);
  console.log(`[iota_oracle_webview] examples dir: ${config.oracleExamplesDir}`);
  console.log(`[iota_oracle_webview] dist dir: ${distPath}`);
  console.log(`[iota_oracle_webview] built assets: ${builtAssetRefs.join(", ")}`);
  console.log(`[iota_oracle_webview] env cwd: ${envDebug.cwd}`);
  console.log(`[iota_oracle_webview] active network: ${getActiveNetwork()}`);
  console.log(`[iota_oracle_webview] supported networks: ${getSupportedNetworks().join(", ")}`);
  console.log(`[iota_oracle_webview] IOTA_RPC_URL loaded: ${runtime.rpcUrl ? "yes" : "no"}`);
  console.log(`[iota_oracle_webview] ORACLE_TASKS_PACKAGE_ID loaded: ${runtime.oracleTasksPackageId ? "yes" : "no"}`);
  console.log(`[iota_oracle_webview] ORACLE_SYSTEM_PACKAGE_ID loaded: ${runtime.oracleSystemPackageId ? "yes" : "no"}`);
  console.log(`[iota_oracle_webview] ORACLE_STATE_ID loaded: ${runtime.oracleStateId ? "yes" : "no"}`);
});
