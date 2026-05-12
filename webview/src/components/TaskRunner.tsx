// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { useEffect, useMemo, useRef, useState } from "react";
import { useCurrentAccount, useSignTransaction } from "@iota/dapp-kit";
import { IotaClient } from "@iota/iota-sdk/client";
import { fetchExampleContent, fetchTaskSchedules, prepareWalletTask, prepareWalletTaskSchedule } from "../lib/api";
import { getChainForOracleNetwork } from "../lib/iotaNetwork";
import { resolveApiBaseUrl } from "../lib/apiBase";
import { validateTaskMultisig } from "../lib/multisigValidation";
import type {
  ExampleTask,
  OracleNetwork,
  PreparedTaskScheduleWalletResponse,
  PreparedWalletTaskResponse,
  RegisteredOracleNode,
} from "../types";

type Props = {
  examples: ExampleTask[];
  activeNetwork: OracleNetwork;
  registeredNodes: RegisteredOracleNode[];
  onExecuted: () => void;
  onTemplateIdChange?: (templateId: string) => void;
  onOpenScheduledTasks?: () => void;
};

type TaskStatusKind = "submitted" | "pending" | "finalized" | "no_consensus" | "failed" | "error";

type NoCommitMessage = {
  sender: string;
  round: number;
  reasonCode: number;
  message: string;
  txDigest: string;
  timestampMs: string | null;
};

type TaskLiveState = {
  kind: TaskStatusKind;
  state: number | null;
  phaseLabel: string;
  detail: string;
  round: number;
  mediationAttempts: number;
  mediationStatus: number;
  mediationVariance: number;
  resultText: string | null;
  noCommitMessages: NoCommitMessage[];
  updatedAt: string;
};

type WalletRunResult = {
  prepared: PreparedWalletTaskResponse;
  digest: string;
  taskId: string;
  live: TaskLiveState;
};

type WalletScheduledResult = {
  prepared: PreparedTaskScheduleWalletResponse;
  digest: string;
  taskId: string | null;
};

type TaskBudgetQuote = {
  requiredPerRunNanoIota: bigint;
  requiredPerRunIotaText: string;
};

type ScheduleSyncSource = "budget" | "end";

type TaskDetail = {
  assigned_nodes?: Array<string | number>;
  certificate_signers?: Array<string | number>;
  state?: number | string | null;
  status?: number | string | null;
  execution_state?: number | string | null;
  active_round?: number | string | null;
  multisig_bytes?: unknown;
  multisig_addr?: string | null;
  quorum_k?: number | string;
  result?: unknown;
  result_bytes?: number[] | Uint8Array | string | null;
  result_hash?: number[] | Uint8Array | string | null;
  latest_result?: unknown;
};

type TaskEvent = {
  type?: string | null;
  sender?: string | null;
  timestampMs?: string | number | null;
  parsedJson?: Record<string, unknown> | null;
};

type FailureReason = {
  code: number;
  label: string;
  description: string;
};

type NodeProtocolProgress = {
  commitPublished: boolean;
  revealPublished: boolean;
  partialSignaturePublished: boolean;
};

type StageTone = "neutral" | "success" | "danger";

type ProtocolStage = {
  key: string;
  label: string;
  tone?: StageTone;
  active: boolean;
  completed: boolean;
};

type TaskCompositeState = {
  taskFields: Record<string, any>;
  configFields: Record<string, any>;
  runtimeFields: Record<string, any>;
  taskType: string;
};

const POLL_MS = 1500;
const MAX_POLL_MS = 180_000;
const MEDIATION_MEAN_U64 = 1;
const MIN_SCHEDULE_INTERVAL_MINUTES = 5;

const MSG_NO_COMMIT = 7;
const NO_COMMIT_FETCH_LIMIT = 200;
const API_BASE = resolveApiBaseUrl();
const MAINNET_RPC_URL = import.meta.env.VITE_IOTA_MAINNET_RPC_URL?.trim() || "https://api.mainnet.iota.cafe";
const TESTNET_RPC_URL = import.meta.env.VITE_IOTA_TESTNET_RPC_URL?.trim() || "https://api.testnet.iota.cafe";
const DEVNET_RPC_URL =
  import.meta.env.VITE_IOTA_DEVNET_RPC_URL?.trim() ||
  import.meta.env.VITE_IOTA_RPC_URL?.trim() ||
  "https://api.devnet.iota.cafe";

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
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

  return null;
}

function getMoveFields(value: unknown): Record<string, any> {
  return extractFields(value) ?? {};
}

function moveObjectIdToString(value: any): string {
  if (typeof value === "string") return value.trim();
  const record = asRecord(value);
  if (!record) return "";
  for (const key of ["id", "objectId", "bytes"]) {
    if (typeof record[key] === "string") return String(record[key]).trim();
  }
  if (typeof record.value === "string") return record.value.trim();
  return "";
}

function decodeVecU8(value: any): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) return Uint8Array.from(value);

  const record = asRecord(value);
  if (!record) return new Uint8Array();

  if (Array.isArray(record.bytes) && record.bytes.every((item) => typeof item === "number")) {
    return Uint8Array.from(record.bytes as number[]);
  }

  if (Array.isArray(record.value) && record.value.every((item) => typeof item === "number")) {
    return Uint8Array.from(record.value as number[]);
  }

  const fields = extractFields(record);
  if (fields) {
    return decodeVecU8(fields.bytes ?? fields.value ?? fields.data ?? []);
  }

  return new Uint8Array();
}

function bytesToPrettyText(bytes: Uint8Array): string | null {
  if (!bytes.length) return null;
  try {
    const text = new TextDecoder().decode(bytes).trim();
    if (!text) return null;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  } catch {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}

function resultValueToPrettyText(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }

  const bytesText = bytesToPrettyText(decodeVecU8(value as any));
  if (bytesText) return bytesText;

  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["result", "result_bytes", "bytes", "value", "contents", "data"]) {
    if (!(key in record)) continue;
    const nested = resultValueToPrettyText(record[key]);
    if (nested) return nested;
  }

  return null;
}

function shortAddress(address: string, start = 10, end = 8): string {
  if (!address) return "-";
  if (address.length <= start + end + 3) return address;
  return `${address.slice(0, start)}...${address.slice(-end)}`;
}

function formatValidatorLabel(name?: string | null, id?: string | null): string | null {
  if (name) return name;
  if (!id) return null;
  return shortAddress(id, 10, 8);
}

function extractArrayLike(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function extractTaskId(execution: any): string {
  const objectChanges = extractArrayLike(execution?.objectChanges ?? execution?.object_changes);
  const createdTask = objectChanges.find(
    (item: any) =>
      item?.type === "created" &&
      String(item?.objectType ?? item?.object_type ?? "").includes("::oracle_tasks::Task") &&
      !String(item?.objectType ?? item?.object_type ?? "").includes("TaskOwnerCap"),
  );
  const byObjectChange = String(createdTask?.objectId ?? createdTask?.object_id ?? "").trim();
  if (byObjectChange) return byObjectChange;

  const events = extractArrayLike(execution?.events);
  const createdEvent = events.find((item: any) => {
    const type = String(item?.type ?? "");
    return type.endsWith("::oracle_tasks::TaskCreated") || type.endsWith("::oracle_tasks::TaskLifecycleEvent");
  });

  const parsed = asRecord(createdEvent?.parsedJson) ?? asRecord(createdEvent?.parsed_json) ?? {};
  const byEvent = moveObjectIdToString(parsed.task_id ?? parsed.taskId);
  return byEvent;
}

function extractCreatedTaskId(execution: any): string {
  const objectChanges = extractArrayLike(execution?.objectChanges ?? execution?.object_changes);
  const createdTask = objectChanges.find(
    (item: any) =>
      item?.type === "created" &&
      String(item?.objectType ?? item?.object_type ?? "").includes("::oracle_tasks::Task") &&
      !String(item?.objectType ?? item?.object_type ?? "").includes("TaskOwnerCap") &&
      !String(item?.objectType ?? item?.object_type ?? "").includes("TaskControllerCap") &&
      !String(item?.objectType ?? item?.object_type ?? "").includes("TaskRegistry") &&
      !String(item?.objectType ?? item?.object_type ?? "").includes("TaskResult"),
  );
  const byObjectChange = String(createdTask?.objectId ?? createdTask?.object_id ?? "").trim();
  if (byObjectChange) return byObjectChange;

  const ownerOrControllerCap = objectChanges.find((item: any) => {
    if (item?.type !== "created") return false;
    const objectType = String(item?.objectType ?? item?.object_type ?? "");
    return (
      objectType.includes("::oracle_tasks::TaskOwnerCap") || objectType.includes("::oracle_tasks::TaskControllerCap")
    );
  });
  const capTaskId = moveObjectIdToString(
    ownerOrControllerCap?.fields?.task_id ??
      ownerOrControllerCap?.fields?.taskId ??
      ownerOrControllerCap?.content?.fields?.task_id ??
      ownerOrControllerCap?.content?.fields?.taskId ??
      ownerOrControllerCap?.parsedJson?.task_id ??
      ownerOrControllerCap?.parsed_json?.task_id,
  );
  if (capTaskId) return capTaskId;

  const events = extractArrayLike(execution?.events);
  const createdEvent = events.find((item: any) => {
    const type = String(item?.type ?? "");
    return type.endsWith("::oracle_tasks::TaskCreated");
  });

  const parsed = asRecord(createdEvent?.parsedJson) ?? asRecord(createdEvent?.parsed_json) ?? {};
  const byEvent = moveObjectIdToString(
    parsed.task_id ?? parsed.taskId ?? parsed.created_task_id ?? parsed.createdTaskId,
  );
  if (byEvent) return byEvent;

  const effectsCreated = extractArrayLike(execution?.effects?.created);
  const byEffects = effectsCreated.find((item: any) => {
    const objectType = String(item?.owner?.ObjectOwner ?? item?.reference?.objectType ?? item?.objectType ?? "");
    return objectType.includes("::oracle_tasks::Task");
  });
  const effectObjectId = String(
    byEffects?.reference?.objectId ?? byEffects?.objectId ?? byEffects?.object_id ?? "",
  ).trim();
  return effectObjectId;
}

function formatDateTimeLocalInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function datetimeLocalToMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : Number.NaN;
}

const SCHEDULE_ALIGNMENT_MS = 60_000;

function ceilToMinuteBoundary(ms: number): number {
  if (!Number.isFinite(ms)) return Number.NaN;
  const remainder = ms % SCHEDULE_ALIGNMENT_MS;
  if (remainder === 0) return ms;
  return ms + (SCHEDULE_ALIGNMENT_MS - remainder);
}

function toDatetimeLocalValue(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function normalizeScheduleInputValue(value: string): string {
  if (!value.trim()) return "";
  const parsedMs = datetimeLocalToMs(value);
  if (!Number.isFinite(parsedMs)) return value;
  return toDatetimeLocalValue(ceilToMinuteBoundary(parsedMs));
}

function currentAlignedMinuteMs(nowMs = Date.now()): number {
  return ceilToMinuteBoundary(nowMs);
}

function parseIotaToNano(value: string): bigint {
  const text = String(value ?? "").trim();
  if (!text) return 0n;
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error("Initial funds must be a positive IOTA amount.");
  }
  const [wholePart, fractionalPart = ""] = text.split(".");
  const whole = BigInt(wholePart || "0") * 1_000_000_000n;
  const fractional = BigInt((fractionalPart + "000000000").slice(0, 9) || "0");
  return whole + fractional;
}

function formatNanoIotaToIota(value: bigint): string {
  const whole = value / 1_000_000_000n;
  const fractional = (value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fractional ? `${whole.toString()}.${fractional}` : whole.toString();
}

async function fetchExecutionForDigest(iotaClient: any, digest: string, fallbackExecution: any): Promise<any> {
  const options = {
    showRawEffects: true,
    showEffects: true,
    showObjectChanges: true,
    showEvents: true,
  };

  if (!digest) return fallbackExecution;

  if (typeof iotaClient?.waitForTransaction === "function") {
    try {
      return await iotaClient.waitForTransaction({ digest, options });
    } catch {
      // fall through
    }
  }

  if (typeof iotaClient?.getTransactionBlock === "function") {
    try {
      return await iotaClient.getTransactionBlock({ digest, options });
    } catch {
      // fall through
    }
  }

  return fallbackExecution;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matchesCreatedScheduleCandidate(args: {
  item: any;
  creator: string;
  templateId: number;
  startScheduleMs: string;
  endScheduleMs: string;
  intervalMs: string;
  initialFunds: string;
}): boolean {
  const { item, creator, templateId, startScheduleMs, endScheduleMs, intervalMs, initialFunds } = args;
  if (!item) return false;
  if (normalizeAddress(item.creator) !== normalizeAddress(creator)) return false;
  if (String(item.templateId ?? "") !== String(templateId)) return false;
  if (String(item.startScheduleMs ?? "") !== startScheduleMs) return false;
  if (String(item.endScheduleMs ?? "") !== endScheduleMs) return false;
  if (String(item.intervalMs ?? "") !== intervalMs) return false;
  if (String(item.balanceIota ?? "") !== initialFunds) return false;
  return true;
}

async function findScheduledTaskIdByRegistry(args: {
  network: OracleNetwork;
  creator: string;
  prepared: PreparedTaskScheduleWalletResponse;
  existingIds: Set<string>;
}): Promise<string | null> {
  const { network, creator, prepared, existingIds } = args;
  const templateId = prepared.template.templateId;
  const startScheduleMs = String(prepared.schedule.startScheduleMs ?? "");
  const endScheduleMs = String(prepared.schedule.endScheduleMs ?? "");
  const intervalMs = String(prepared.schedule.intervalMs ?? "");
  const initialFunds = String(prepared.initialFunds ?? "");

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await fetchTaskSchedules(network);
      const items = Array.isArray(response?.items) ? response.items : [];
      const exactNewMatch = items.find((item: any) => {
        const id = normalizeAddress(item?.id);
        return (
          id &&
          !existingIds.has(id) &&
          matchesCreatedScheduleCandidate({
            item,
            creator,
            templateId,
            startScheduleMs,
            endScheduleMs,
            intervalMs,
            initialFunds,
          })
        );
      });
      if (exactNewMatch?.id) return normalizeAddress(exactNewMatch.id);

      const fallbackExactMatch = items.find((item: any) =>
        matchesCreatedScheduleCandidate({
          item,
          creator,
          templateId,
          startScheduleMs,
          endScheduleMs,
          intervalMs,
          initialFunds,
        }),
      );
      if (fallbackExactMatch?.id) return normalizeAddress(fallbackExactMatch.id);
    } catch {
      // keep polling briefly
    }

    await sleep(800);
  }

  return null;
}

function extractPackageIdFromMoveType(typeName: string): string {
  const value = String(typeName ?? "").trim();
  if (!value) return "";
  const idx = value.indexOf("::");
  if (idx <= 0) return "";
  return value.slice(0, idx);
}

function normalizeAddress(address: string): string {
  const value = String(address ?? "")
    .trim()
    .toLowerCase();
  if (!value) return "";
  return value.startsWith("0x") ? value : `0x${value}`;
}

function fieldNumber(record: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function eventTypeName(type: string | null | undefined): string {
  const value = String(type ?? "").trim();
  if (!value) return "";
  const match = value.match(/::([^:<]+)(?:<.*>)?$/);
  return match ? match[1] : value;
}

function describeReasonCode(reasonCode: number): FailureReason {
  switch (reasonCode) {
    case 1:
      return {
        code: reasonCode,
        label: "EXECUTION_FAILED",
        description:
          "The node could not complete task execution locally, so it explicitly opted out of the commit phase.",
      };
    case 1002:
      return {
        code: reasonCode,
        label: "COMMIT_TIMEOUT",
        description: "The commit window ended before enough commit messages were received.",
      };
    case 1003:
      return {
        code: reasonCode,
        label: "REVEAL_NO_QUORUM",
        description: "Nodes revealed different outputs and no winning result reached quorum.",
      };
    case 1004:
      return {
        code: reasonCode,
        label: "COMMIT_NO_QUORUM",
        description: "Enough nodes declared no_commit, making commit quorum mathematically impossible.",
      };
    case 1005:
      return {
        code: reasonCode,
        label: "PARTIAL_SIG_TIMEOUT",
        description: "A winning result existed, but the leader did not collect enough partial signatures to finalize.",
      };
    default:
      return {
        code: reasonCode,
        label: reasonCode > 0 ? `REASON_${reasonCode}` : "UNKNOWN_REASON",
        description: "The protocol recorded a failure reason code that is not explicitly mapped in the webview.",
      };
  }
}

function decodeAsciiJson(value: unknown): Record<string, unknown> | null {
  const bytes = decodeVecU8(value as any);
  if (!bytes.length) return null;
  try {
    const text = new TextDecoder().decode(bytes).trim();
    if (!text) return null;
    const parsed = JSON.parse(text);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function extractLatestFailureReason(events: TaskEvent[]): FailureReason | null {
  const failedEvents = events
    .map((event) => {
      if (eventTypeName(event.type) !== "TaskFailed") return null;
      const reasonCode = fieldNumber(asRecord(event.parsedJson), "reason_code", "reasonCode") ?? 0;
      return {
        timestamp: Number(event.timestampMs ?? 0),
        reason: describeReasonCode(reasonCode),
      };
    })
    .filter(Boolean) as Array<{ timestamp: number; reason: FailureReason }>;

  failedEvents.sort((a, b) => b.timestamp - a.timestamp);
  return failedEvents[0]?.reason ?? null;
}

function extractFailureReasonFromTaskDetail(taskDetail: TaskDetail | null): FailureReason | null {
  const debug = decodeAsciiJson(taskDetail?.multisig_bytes);
  if (!debug) return null;

  const kind = String(debug.kind ?? "")
    .trim()
    .toLowerCase();
  if (kind !== "abort") return null;

  const reasonCode = fieldNumber(debug, "reasonCode", "reason_code", "value0") ?? 0;
  return describeReasonCode(reasonCode);
}

function getEventSenderAddress(event: TaskEvent): string {
  const parsedSender = asRecord(event.parsedJson)?.sender;
  return normalizeAddress(String(parsedSender ?? event.sender ?? ""));
}

function extractNodeProtocolProgress(events: TaskEvent[]): Map<string, NodeProtocolProgress> {
  const progressByNode = new Map<string, NodeProtocolProgress>();

  for (const event of events) {
    if (eventTypeName(event.type) !== "OracleMessage") continue;

    const sender = getEventSenderAddress(event);
    if (!sender) continue;

    const kind = fieldNumber(asRecord(event.parsedJson), "kind", "message_kind") ?? -1;
    const current = progressByNode.get(sender) ?? {
      commitPublished: false,
      revealPublished: false,
      partialSignaturePublished: false,
    };

    if (kind === 2) current.commitPublished = true;
    if (kind === 3) current.revealPublished = true;
    if (kind === 4) current.partialSignaturePublished = true;

    progressByNode.set(sender, current);
  }

  return progressByNode;
}

function extractNoCommitMessage(parsedJson: any, event: any): NoCommitMessage | null {
  const parsed = asRecord(parsedJson);
  if (!parsed) return null;

  const taskId = moveObjectIdToString(parsed.task_id ?? parsed.taskId);
  if (!taskId) return null;

  const kind = Number(parsed.kind ?? -1);
  if (kind !== MSG_NO_COMMIT) return null;

  return {
    sender: normalizeAddress(String(parsed.sender ?? event?.sender ?? "")),
    round: Number(parsed.round ?? 0),
    reasonCode: Number(parsed.value0 ?? 0),
    message: bytesToPrettyText(decodeVecU8(parsed.payload)) ?? "",
    txDigest: String(event?.id?.txDigest ?? ""),
    timestampMs: typeof event?.timestampMs === "string" ? event.timestampMs : null,
  };
}

async function readNoCommitMessages(iotaClient: any, taskId: string, taskType: string): Promise<NoCommitMessage[]> {
  const packageId = extractPackageIdFromMoveType(taskType);
  if (!packageId || typeof iotaClient?.queryEvents !== "function") return [];

  const page = await iotaClient.queryEvents({
    query: {
      MoveModule: {
        package: packageId,
        module: "oracle_messages",
      },
    },
    limit: NO_COMMIT_FETCH_LIMIT,
  });

  const normalizedTaskId = normalizeAddress(taskId);
  const items = extractArrayLike(page?.data)
    .map((event: any) => {
      const item = extractNoCommitMessage(event?.parsedJson ?? event?.parsed_json, event);
      if (!item) return null;
      const eventTaskId = moveObjectIdToString(
        (event?.parsedJson ?? event?.parsed_json)?.task_id ?? (event?.parsedJson ?? event?.parsed_json)?.taskId,
      );
      if (normalizeAddress(eventTaskId) !== normalizedTaskId) return null;
      return item;
    })
    .filter(Boolean) as NoCommitMessage[];

  items.sort((a, b) => {
    const ta = Number(a.timestampMs ?? 0);
    const tb = Number(b.timestampMs ?? 0);
    return tb - ta;
  });

  return items;
}

function normalizeTaskText(value: string): { task: unknown; normalizedText: string } {
  const task = JSON.parse(value);
  return {
    task,
    normalizedText: JSON.stringify(task),
  };
}

async function readTaskCompositeState(iotaClient: any, taskId: string): Promise<TaskCompositeState> {
  const taskObj = await iotaClient.getObject({ id: taskId, options: { showContent: true, showType: true } });
  const taskFields = getMoveFields(taskObj);

  return {
    taskFields,
    configFields: taskFields,
    runtimeFields: taskFields,
    taskType: String(taskObj?.data?.type ?? ""),
  };
}

function compatStateFromTask(task: Record<string, any>): number {
  const direct = Number(task.state ?? NaN);
  if (Number.isFinite(direct)) return direct;
  const executionState = Number(task.execution_state ?? -1);
  if (executionState === 1) return 1;
  if (executionState === 2) return 2;
  if (executionState === 9) return 9;
  if (executionState === 10) return 10;
  return 0;
}

function phaseLabelForState(state: number): string {
  switch (state) {
    case 1:
      return "Commit phase";
    case 2:
      return "Reveal phase";
    case 3:
      return "Collecting raw data";
    case 4:
      return "No consensus";
    case 9:
      return "Completed";
    case 10:
      return "Failed";
    default:
      return "Pending";
  }
}

function describeSnapshot(
  snapshot: TaskCompositeState,
  taskDetail: TaskDetail | null,
  registeredNodes: RegisteredOracleNode[],
): TaskLiveState {
  const task = snapshot.taskFields;
  const config = snapshot.configFields;
  const runtime = snapshot.runtimeFields;

  const state = compatStateFromTask(task);
  const round = Number(task.active_round ?? runtime.active_round ?? 0);
  const mediationMode = Number(task.mediation_mode ?? config.mediation_mode ?? runtime.mediation_mode ?? 0);
  const mediationAttempts = Number(task.mediation_attempts ?? runtime.mediation_attempts ?? 0);
  const mediationStatus = Number(task.mediation_status ?? runtime.mediation_status ?? 0);
  const mediationVariance = Number(task.mediation_variance ?? runtime.mediation_variance ?? 0);
  const executionState = Number(task.execution_state ?? runtime.execution_state ?? -1);
  const resultText =
    resultValueToPrettyText(taskDetail?.result) ??
    resultValueToPrettyText(taskDetail?.result_bytes) ??
    resultValueToPrettyText(task.result) ??
    resultValueToPrettyText(runtime.result) ??
    resultValueToPrettyText(task.result_bytes) ??
    resultValueToPrettyText(runtime.result_bytes);
  const mediationEnabled = mediationMode === MEDIATION_MEAN_U64;
  const multisigValidation = validateTaskMultisig(
    taskDetail ?? {
      multisig_addr: task.multisig_addr,
      multisig_bytes: task.multisig_bytes,
      certificate_signers: task.certificate_signers,
      quorum_k: task.quorum_k ?? config.quorum_k,
      result: task.result,
      result_bytes: task.result_bytes,
      result_hash: task.result_hash,
    },
    registeredNodes,
  );
  const finalizedOnChain = state === 9 || executionState === 9;
  const finalizedWithValidMultisig = finalizedOnChain && multisigValidation.addressStatus === "match";

  if (finalizedOnChain || resultText) {
    const detail = resultText
      ? "Result received from oracle network."
      : finalizedWithValidMultisig
        ? "Task finalized on-chain."
        : multisigValidation.addressStatus === "stored_is_signer"
          ? "Task finalized on-chain. Dashboard multisig verification is inconclusive because the stored multisig address matches a signer address."
          : typeof multisigValidation.derivedError === "string" && multisigValidation.derivedError.trim()
            ? `Task finalized on-chain. Dashboard multisig verification is unavailable: ${multisigValidation.derivedError}`
            : "Task finalized on-chain.";
    return {
      kind: "finalized",
      state,
      phaseLabel: "Completed",
      detail,
      round,
      mediationAttempts,
      mediationStatus,
      mediationVariance,
      resultText,
      noCommitMessages: [],
      updatedAt: new Date().toISOString(),
    };
  }

  if (state === 10 || executionState === 10) {
    if (mediationEnabled && (mediationStatus === 2 || mediationAttempts > 0)) {
      return {
        kind: "no_consensus",
        state,
        phaseLabel: "No consensus",
        detail:
          mediationStatus === 2
            ? `Mediation blocked. Observed variance: ${mediationVariance}.`
            : "Mediation was attempted but the task did not converge.",
        round,
        mediationAttempts,
        mediationStatus,
        mediationVariance,
        resultText: null,
        noCommitMessages: [],
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      kind: "failed",
      state,
      phaseLabel: "Failed",
      detail: "The task ended in a failed state on-chain.",
      round,
      mediationAttempts,
      mediationStatus,
      mediationVariance,
      resultText: null,
      noCommitMessages: [],
      updatedAt: new Date().toISOString(),
    };
  }

  if (state === 4) {
    if (!mediationEnabled || mediationStatus === 2 || mediationAttempts > 0) {
      return {
        kind: "no_consensus",
        state,
        phaseLabel: "No consensus",
        detail:
          mediationStatus === 2
            ? `Consensus not reached and mediation blocked. Variance: ${mediationVariance}.`
            : "Consensus not reached.",
        round,
        mediationAttempts,
        mediationStatus,
        mediationVariance,
        resultText: null,
        noCommitMessages: [],
        updatedAt: new Date().toISOString(),
      };
    }
  }

  return {
    kind: state >= 0 ? "pending" : "submitted",
    state,
    phaseLabel: phaseLabelForState(state),
    detail: state === 4 ? "Waiting for mediation round." : "Waiting for oracle nodes to complete the task.",
    round,
    mediationAttempts,
    mediationStatus,
    mediationVariance,
    resultText: null,
    noCommitMessages: [],
    updatedAt: new Date().toISOString(),
  };
}

function buildProtocolStages(
  live: TaskLiveState,
  opts?: {
    anyCommitPublished?: boolean;
    anyRevealPublished?: boolean;
    anyPartialSignaturePublished?: boolean;
  },
): ProtocolStage[] {
  const terminalFail = live.kind === "failed" || live.kind === "error" || live.kind === "no_consensus";
  const finalized = live.kind === "finalized";
  const state = live.state ?? null;
  const mediationStarted = live.round > 0 || live.mediationAttempts > 0 || live.mediationStatus === 1;
  const mediationRunning = mediationStarted && !finalized && !terminalFail;
  const anyCommitPublished = Boolean(opts?.anyCommitPublished);
  const anyRevealPublished = Boolean(opts?.anyRevealPublished);
  const anyPartialSignaturePublished = Boolean(opts?.anyPartialSignaturePublished);

  let currentKey = "submitted";
  if (finalized) {
    currentKey = "finalize";
  } else if (terminalFail) {
    currentKey = "fail";
  } else if (mediationRunning) {
    currentKey = "mediation";
  } else if (anyPartialSignaturePublished) {
    currentKey = "finalize";
  } else if (anyRevealPublished || state === 2) {
    currentKey = "reveal";
  } else if (anyCommitPublished || state === 1) {
    currentKey = "commit";
  }

  const stages: ProtocolStage[] = [
    {
      key: "submitted",
      label: "Submitted",
      tone: "neutral",
      active: currentKey === "submitted",
      completed: currentKey !== "submitted",
    },
    {
      key: "commit",
      label: "Commit",
      tone: "neutral",
      active: currentKey === "commit",
      completed: ["reveal", "mediation", "finalize", "fail"].includes(currentKey),
    },
    {
      key: "reveal",
      label: "Reveal",
      tone: "neutral",
      active: currentKey === "reveal",
      completed: ["mediation", "finalize", "fail"].includes(currentKey),
    },
    {
      key: "mediation",
      label: "Mediation",
      tone: "neutral",
      active: currentKey === "mediation",
      completed: mediationStarted && (finalized || currentKey === "fail"),
    },
    { key: "finalize", label: "Finalize", tone: "success", active: currentKey === "finalize", completed: finalized },
    { key: "fail", label: "Fail", tone: "danger", active: currentKey === "fail", completed: terminalFail },
  ];

  return stages;
}

function statusBadgeClass(kind: TaskStatusKind): string {
  if (kind === "finalized") return "badge-ok";
  if (kind === "failed" || kind === "error") return "badge-err";
  if (kind === "no_consensus") return "badge-warn";
  return "badge-muted";
}

function formatUserFacingError(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  let message = rawMessage;

  try {
    const parsed = JSON.parse(rawMessage);
    if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
      message = (parsed as { error: string }).error;
    }
  } catch {
    // Keep the original message when it is not JSON.
  }

  if (/Insufficient IOTA for address/i.test(message)) {
    return "Error: Insufficient IOTA";
  }
  if (/Template\s+\d+\s+not found under state/i.test(message)) {
    return "The selected task template is not available on the active network. Reload an on-chain example for this network or update the template_id in your JSON.";
  }
  if (/must be aligned to the start of a minute/i.test(message) || /EInvalidScheduleAlignment/i.test(message)) {
    return "Schedule times must be aligned to minute boundaries. Use seconds 00 for start, end, and interval.";
  }
  if (
    /abort code:\s*1002/i.test(message) ||
    /EInvalidInterval/i.test(message) ||
    /interval_ms must be at least 300000/i.test(message)
  ) {
    return "Schedule interval must be at least 5 minutes.";
  }
  if (/abort code:\s*1001/i.test(message) || /EInvalidScheduleWindow/i.test(message)) {
    return "Schedule end must be greater than or equal to schedule start.";
  }
  if (/abort code:\s*1003/i.test(message) || /ENoSchedulerNodes/i.test(message)) {
    return "No scheduler-enabled nodes are currently registered on the active network.";
  }
  if (/abort code:\s*1010/i.test(message) || /ENotEnoughOracleNodes/i.test(message)) {
    return "Not enough active oracle nodes support this template on the active network for the requested node count.";
  }
  if (/abort code:\s*1011/i.test(message) || /EInvalidQuorum/i.test(message)) {
    return "The requested quorum is invalid for the current requested node count.";
  }
  const templateNotFound = message.match(/Template\s+(\d+)\s+not found under state\s+(0x[a-f0-9]+)/i);
  if (templateNotFound) {
    const [, templateId, stateId] = templateNotFound;
    return `Template ${templateId} is not configured on-chain under state ${stateId}. If nodes list it as supported, it is likely still pending approval and must be proposed/approved before it can be used.`;
  }
  return message;
}

export default function TaskRunner({
  examples,
  activeNetwork,
  registeredNodes,
  onExecuted,
  onTemplateIdChange,
  onOpenScheduledTasks,
}: Props) {
  const [taskText, setTaskText] = useState<string>("{}");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WalletRunResult | null>(null);
  const [taskScheduleResult, setTaskScheduleResult] = useState<WalletScheduledResult | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [taskEvents, setTaskEvents] = useState<TaskEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedExample, setSelectedExample] = useState<string>("");
  const [scheduleStart, setScheduleStart] = useState<string>(() => toDatetimeLocalValue(currentAlignedMinuteMs()));
  const [scheduleEnd, setScheduleEnd] = useState<string>(() => toDatetimeLocalValue(currentAlignedMinuteMs()));
  const [scheduleIntervalMinutes, setScheduleIntervalMinutes] = useState<string>("");
  const [scheduleInitialFundsIota, setScheduleInitialFundsIota] = useState<string>("5");
  const [scheduleSyncSource, setScheduleSyncSource] = useState<ScheduleSyncSource>("budget");
  const [budgetQuote, setBudgetQuote] = useState<TaskBudgetQuote | null>(null);
  const [budgetQuoteError, setBudgetQuoteError] = useState<string | null>(null);
  const currentAccount = useCurrentAccount();
  const iotaClients = useMemo(
    () => ({
      mainnet: new IotaClient({ url: MAINNET_RPC_URL }),
      testnet: new IotaClient({ url: TESTNET_RPC_URL }),
      devnet: new IotaClient({ url: DEVNET_RPC_URL }),
    }),
    [],
  );
  const nodeMetaByAddress = useMemo(
    () =>
      new Map(
        registeredNodes
          .map(
            (node) =>
              [
                normalizeAddress(node.address),
                {
                  validatorLabel: formatValidatorLabel(node.validatorName, node.validatorId),
                  validatorId: node.validatorId ?? null,
                },
              ] as const,
          )
          .filter(([address]) => Boolean(address)),
      ),
    [registeredNodes],
  );
  const pollTokenRef = useRef(0);
  const finalizedResultRefetchKeyRef = useRef<string>("");
  const { mutateAsync: signTransaction } = useSignTransaction();

  useEffect(() => {
    return () => {
      pollTokenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const taskId = result?.taskId?.trim();
    if (!taskId) {
      setTaskDetail(null);
      setTaskEvents([]);
      return;
    }

    let cancelled = false;
    const loadTaskDetail = async () => {
      try {
        const [detailResponse, eventsResponse] = await Promise.all([
          fetch(`${API_BASE}/api/task/${encodeURIComponent(taskId)}`),
          fetch(`${API_BASE}/api/task/${encodeURIComponent(taskId)}/events`),
        ]);
        if (!detailResponse.ok) {
          throw new Error(`Unable to load task detail: HTTP ${detailResponse.status}`);
        }
        const payload = (await detailResponse.json()) as TaskDetail;
        const eventsPayload = eventsResponse.ok ? ((await eventsResponse.json()) as { events?: TaskEvent[] }) : null;
        if (!cancelled) {
          setTaskDetail(payload);
          setTaskEvents(Array.isArray(eventsPayload?.events) ? eventsPayload.events : []);
        }
      } catch {
        if (!cancelled) {
          setTaskDetail(null);
          setTaskEvents([]);
        }
      }
    };

    void loadTaskDetail();
    return () => {
      cancelled = true;
    };
  }, [result?.taskId, result?.live.updatedAt]);

  useEffect(() => {
    if (!result?.taskId) return;
    if (!taskDetail && taskEvents.length === 0) return;

    try {
      const snapshot: TaskCompositeState = {
        taskFields: (taskDetail as Record<string, any> | null) ?? {},
        configFields: (taskDetail as Record<string, any> | null) ?? {},
        runtimeFields: (taskDetail as Record<string, any> | null) ?? {},
        taskType: "",
      };
      const baseLive = describeSnapshot(snapshot, taskDetail, registeredNodes);
      const latestNoCommit = baseLive.kind === "failed" ? extractLatestFailureReason(taskEvents) : null;

      setResult((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          live: {
            ...baseLive,
            noCommitMessages: prev.live.noCommitMessages,
            detail: baseLive.kind === "failed" && latestNoCommit ? latestNoCommit.description : baseLive.detail,
            updatedAt: prev.live.updatedAt,
          },
        };
      });
    } catch {
      // Keep the last live snapshot if detail/event hydration is incomplete.
    }
  }, [registeredNodes, result?.taskId, taskDetail, taskEvents]);

  const failureReason = useMemo(
    () => extractLatestFailureReason(taskEvents) ?? extractFailureReasonFromTaskDetail(taskDetail),
    [taskDetail, taskEvents],
  );

  const displayResultText = useMemo(() => {
    return (
      result?.live.resultText ??
      resultValueToPrettyText(taskDetail?.result) ??
      resultValueToPrettyText(taskDetail?.result_bytes) ??
      resultValueToPrettyText(taskDetail?.latest_result) ??
      null
    );
  }, [result?.live.resultText, taskDetail]);

  useEffect(() => {
    const taskId = result?.taskId?.trim();
    const state = Number(taskDetail?.state ?? result?.live.state ?? -1);
    if (!taskId) return;
    if (state !== 9) {
      finalizedResultRefetchKeyRef.current = "";
      return;
    }
    if (displayResultText) {
      finalizedResultRefetchKeyRef.current = "";
      return;
    }

    const refetchKey = `${taskId}:${state}`;
    if (finalizedResultRefetchKeyRef.current === refetchKey) return;
    finalizedResultRefetchKeyRef.current = refetchKey;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`${API_BASE}/api/task/${encodeURIComponent(taskId)}`);
        if (!response.ok) return;
        const payload = (await response.json()) as TaskDetail;
        if (!cancelled) setTaskDetail(payload);
      } catch {
        // Best-effort refresh only.
      } finally {
        if (!cancelled) finalizedResultRefetchKeyRef.current = "";
      }
    }, 1200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [displayResultText, result?.live.state, result?.taskId, taskDetail?.state]);

  const assignedNodeRows = useMemo(() => {
    const assignedNodes = Array.isArray(taskDetail?.assigned_nodes)
      ? taskDetail.assigned_nodes.map((item) => normalizeAddress(String(item))).filter(Boolean)
      : [];
    const certificateSigners = new Set(
      Array.isArray(taskDetail?.certificate_signers)
        ? taskDetail.certificate_signers.map((item) => normalizeAddress(String(item))).filter(Boolean)
        : [],
    );
    const nodeProgress = extractNodeProtocolProgress(taskEvents);
    const nodeAddresses = assignedNodes.length ? assignedNodes : Array.from(nodeProgress.keys()).filter(Boolean);

    return nodeAddresses.map((address) => {
      const nodeMeta = nodeMetaByAddress.get(address);
      const progress = nodeProgress.get(address) ?? {
        commitPublished: false,
        revealPublished: false,
        partialSignaturePublished: false,
      };

      let protocolLabel = certificateSigners.has(address) ? "certificate signer" : "assigned";
      let protocolBadge = certificateSigners.has(address) ? "badge-ok" : "badge-muted";
      let protocolHint = "";

      if (failureReason?.code === 1002) {
        if (!progress.commitPublished) {
          protocolLabel = "missing commit";
          protocolBadge = "badge-err";
          protocolHint = "No commit message was observed on-chain before the deadline.";
        } else {
          protocolLabel = "commit received";
          protocolBadge = "badge-ok";
          protocolHint = "This node published a commit on-chain within the observed round.";
        }
      } else if (failureReason?.code === 1003) {
        if (!progress.revealPublished) {
          protocolLabel = "missing reveal";
          protocolBadge = "badge-err";
          protocolHint = "No reveal message was observed on-chain for this node.";
        } else {
          protocolLabel = "reveal received";
          protocolBadge = "badge-ok";
          protocolHint = "This node published a reveal on-chain.";
        }
      } else if (failureReason?.code === 1005) {
        if (!progress.partialSignaturePublished) {
          protocolLabel = "missing partial sig";
          protocolBadge = "badge-err";
          protocolHint = "No partial signature was observed on-chain for this node.";
        } else {
          protocolLabel = "partial sig received";
          protocolBadge = "badge-ok";
          protocolHint = "This node published a partial signature on-chain.";
        }
      } else if (progress.partialSignaturePublished) {
        protocolLabel = "partial sig received";
        protocolBadge = "badge-ok";
        protocolHint = "This node published a partial signature on-chain.";
      } else if (progress.revealPublished) {
        protocolLabel = "reveal received";
        protocolBadge = "badge-ok";
        protocolHint = "This node published a reveal on-chain.";
      } else if (progress.commitPublished) {
        protocolLabel = "commit received";
        protocolBadge = "badge-ok";
        protocolHint = "This node published a commit on-chain.";
      }

      return {
        address,
        signed: certificateSigners.has(address),
        validatorLabel: nodeMeta?.validatorLabel ?? null,
        validatorId: nodeMeta?.validatorId ?? null,
        progress,
        protocolLabel,
        protocolBadge,
        protocolHint,
      };
    });
  }, [failureReason?.code, nodeMetaByAddress, taskDetail, taskEvents]);

  const missingCommitNodes = useMemo(
    () => (failureReason?.code === 1002 ? assignedNodeRows.filter((item) => !item.progress.commitPublished) : []),
    [assignedNodeRows, failureReason?.code],
  );

  const protocolStageState = useMemo(() => {
    const nodeProgress = extractNodeProtocolProgress(taskEvents);
    const values = Array.from(nodeProgress.values());
    const anyCommitPublished = values.some((item) => item.commitPublished);
    const anyRevealPublished = values.some((item) => item.revealPublished);
    const anyPartialSignaturePublished = values.some((item) => item.partialSignaturePublished);
    return { anyCommitPublished, anyRevealPublished, anyPartialSignaturePublished };
  }, [taskEvents]);

  const parsedTask = useMemo(() => {
    try {
      return JSON.parse(taskText);
    } catch {
      return null;
    }
  }, [taskText]);

  const normalizedStartMs = useMemo(() => {
    const parsed = datetimeLocalToMs(scheduleStart);
    if (Number.isFinite(parsed)) return ceilToMinuteBoundary(parsed);
    return currentAlignedMinuteMs();
  }, [scheduleStart]);

  const recurringIntervalMinutes = useMemo(() => {
    const raw = scheduleIntervalMinutes.trim();
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.floor(parsed);
  }, [scheduleIntervalMinutes]);

  const normalizedEndMs = useMemo(() => {
    const parsed = datetimeLocalToMs(scheduleEnd);
    if (Number.isFinite(parsed)) return ceilToMinuteBoundary(parsed);
    return normalizedStartMs;
  }, [normalizedStartMs, scheduleEnd]);

  useEffect(() => {
    if (recurringIntervalMinutes != null) return;
    const alignedStart = toDatetimeLocalValue(normalizedStartMs);
    if (scheduleEnd !== alignedStart) {
      setScheduleEnd(alignedStart);
    }
  }, [normalizedStartMs, recurringIntervalMinutes, scheduleEnd]);

  useEffect(() => {
    let cancelled = false;
    if (!parsedTask || !currentAccount?.address) {
      setBudgetQuote(null);
      setBudgetQuoteError(null);
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const { task } = normalizeTaskText(taskText);
          const prepared = await prepareWalletTask(task, currentAccount.address, activeNetwork);
          if (cancelled) return;
          const requiredPerRunNanoIota = BigInt(prepared.requiredPerRun);
          setBudgetQuote({
            requiredPerRunNanoIota,
            requiredPerRunIotaText: formatNanoIotaToIota(requiredPerRunNanoIota),
          });
          setBudgetQuoteError(null);
        } catch (err) {
          if (!cancelled) {
            setBudgetQuote(null);
            setBudgetQuoteError(formatUserFacingError(err));
          }
        }
      })();
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeNetwork, currentAccount?.address, parsedTask, taskText]);

  useEffect(() => {
    if (
      recurringIntervalMinutes == null ||
      !budgetQuote?.requiredPerRunNanoIota ||
      budgetQuote.requiredPerRunNanoIota <= 0n
    ) {
      return;
    }
    if (scheduleSyncSource !== "budget") return;

    let budgetNanoIota = 0n;
    try {
      budgetNanoIota = parseIotaToNano(scheduleInitialFundsIota);
    } catch {
      budgetNanoIota = 0n;
    }

    const possibleRuns = budgetNanoIota / budgetQuote.requiredPerRunNanoIota;
    const nextEndMs =
      possibleRuns > 0n
        ? normalizedStartMs + Number(possibleRuns - 1n) * recurringIntervalMinutes * 60_000
        : normalizedStartMs;
    const nextEndValue = toDatetimeLocalValue(nextEndMs);
    if (nextEndValue !== scheduleEnd) {
      setScheduleEnd(nextEndValue);
    }
  }, [
    budgetQuote?.requiredPerRunNanoIota,
    normalizedStartMs,
    recurringIntervalMinutes,
    scheduleEnd,
    scheduleInitialFundsIota,
    scheduleSyncSource,
  ]);

  useEffect(() => {
    if (scheduleSyncSource !== "end") return;
    if (!budgetQuote?.requiredPerRunNanoIota || budgetQuote.requiredPerRunNanoIota <= 0n) return;

    if (recurringIntervalMinutes == null) {
      const oneRunBudget = formatNanoIotaToIota(budgetQuote.requiredPerRunNanoIota);
      if (scheduleEnd !== toDatetimeLocalValue(normalizedStartMs)) {
        setScheduleEnd(toDatetimeLocalValue(normalizedStartMs));
      }
      if (scheduleInitialFundsIota !== oneRunBudget) {
        setScheduleInitialFundsIota(oneRunBudget);
      }
      return;
    }

    const effectiveEndMs = Math.max(normalizedEndMs, normalizedStartMs);
    const intervalMs = recurringIntervalMinutes * 60_000;
    const runCount = BigInt(Math.floor((effectiveEndMs - normalizedStartMs) / intervalMs) + 1);
    const requiredBudget = formatNanoIotaToIota(runCount * budgetQuote.requiredPerRunNanoIota);
    const normalizedEndValue = toDatetimeLocalValue(effectiveEndMs);

    if (normalizedEndValue !== scheduleEnd) {
      setScheduleEnd(normalizedEndValue);
    }
    if (scheduleInitialFundsIota !== requiredBudget) {
      setScheduleInitialFundsIota(requiredBudget);
    }
  }, [
    budgetQuote?.requiredPerRunNanoIota,
    normalizedEndMs,
    normalizedStartMs,
    recurringIntervalMinutes,
    scheduleEnd,
    scheduleInitialFundsIota,
    scheduleSyncSource,
  ]);

  const schedulePreview = useMemo(() => {
    const requiredPerRun = budgetQuote?.requiredPerRunNanoIota ?? 0n;
    if (requiredPerRun <= 0n) {
      return {
        startMs: normalizedStartMs,
        endMs: recurringIntervalMinutes == null ? normalizedStartMs : Math.max(normalizedEndMs, normalizedStartMs),
        possibleRuns: null as bigint | null,
      };
    }

    if (recurringIntervalMinutes == null) {
      let budgetNanoIota = 0n;
      try {
        budgetNanoIota = parseIotaToNano(scheduleInitialFundsIota);
      } catch {
        budgetNanoIota = 0n;
      }
      return {
        startMs: normalizedStartMs,
        endMs: normalizedStartMs,
        possibleRuns: budgetNanoIota > 0n ? budgetNanoIota / requiredPerRun : 0n,
      };
    }

    if (scheduleSyncSource === "end") {
      const effectiveEndMs = Math.max(normalizedEndMs, normalizedStartMs);
      const intervalMs = recurringIntervalMinutes * 60_000;
      const possibleRuns = BigInt(Math.floor((effectiveEndMs - normalizedStartMs) / intervalMs) + 1);
      return {
        startMs: normalizedStartMs,
        endMs: effectiveEndMs,
        possibleRuns,
      };
    }

    let budgetNanoIota = 0n;
    try {
      budgetNanoIota = parseIotaToNano(scheduleInitialFundsIota);
    } catch {
      budgetNanoIota = 0n;
    }

    const possibleRuns = budgetNanoIota / requiredPerRun;
    const endMs =
      possibleRuns > 0n
        ? normalizedStartMs + Number(possibleRuns - 1n) * recurringIntervalMinutes * 60_000
        : normalizedStartMs;

    return {
      startMs: normalizedStartMs,
      endMs,
      possibleRuns,
    };
  }, [
    budgetQuote?.requiredPerRunNanoIota,
    normalizedEndMs,
    normalizedStartMs,
    recurringIntervalMinutes,
    scheduleInitialFundsIota,
    scheduleSyncSource,
  ]);

  const budgetStepIota = useMemo(() => {
    if (budgetQuote?.requiredPerRunIotaText) return budgetQuote.requiredPerRunIotaText;
    return "1";
  }, [budgetQuote?.requiredPerRunIotaText]);

  useEffect(() => {
    const templateId =
      parsedTask && typeof parsedTask === "object" && !Array.isArray(parsedTask)
        ? (parsedTask as Record<string, unknown>).template_id
        : null;

    if (typeof templateId === "number" || typeof templateId === "string") {
      onTemplateIdChange?.(String(templateId));
      return;
    }

    onTemplateIdChange?.("");
  }, [parsedTask, onTemplateIdChange]);

  async function onLoadExample(name: string) {
    setSelectedExample(name);
    if (!name) return;
    setError(null);
    try {
      const content = await fetchExampleContent(name);
      setTaskText(JSON.stringify(content, null, 2));
    } catch (err) {
      setError(formatUserFacingError(err));
    }
  }

  async function onFileChange(file: File | null) {
    if (!file) return;
    setError(null);
    const text = await file.text();
    setTaskText(text);
  }

  async function monitorTask(
    networkClient: IotaClient,
    taskId: string,
    basePrepared: PreparedWalletTaskResponse,
    digest: string,
    token: number,
  ) {
    const startedAt = Date.now();

    while (pollTokenRef.current === token && Date.now() - startedAt < MAX_POLL_MS) {
      try {
        const snapshot = await readTaskCompositeState(networkClient, taskId);
        const baseLive = describeSnapshot(snapshot, taskDetail, registeredNodes);
        const noCommitMessages = await readNoCommitMessages(networkClient, taskId, snapshot.taskType).catch(
          () => [] as NoCommitMessage[],
        );
        const latestNoCommit = noCommitMessages[0];
        const live: TaskLiveState = {
          ...baseLive,
          noCommitMessages,
          detail:
            baseLive.kind === "failed" && latestNoCommit?.message
              ? `No commit received: ${latestNoCommit.message}`
              : baseLive.detail,
        };

        setResult({
          prepared: basePrepared,
          digest,
          taskId,
          live,
        });

        if (live.kind === "finalized" || live.kind === "no_consensus" || live.kind === "failed") {
          onExecuted();
          return;
        }
      } catch (err) {
        setResult({
          prepared: basePrepared,
          digest,
          taskId,
          live: {
            kind: "error",
            state: null,
            phaseLabel: "Read error",
            detail: err instanceof Error ? err.message : String(err),
            round: 0,
            mediationAttempts: 0,
            mediationStatus: 0,
            mediationVariance: 0,
            resultText: null,
            noCommitMessages: [],
            updatedAt: new Date().toISOString(),
          },
        });
        return;
      }

      await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
    }

    if (pollTokenRef.current === token) {
      setResult((prev) => {
        if (!prev || prev.taskId !== taskId) return prev;
        return {
          ...prev,
          live: {
            ...prev.live,
            kind: prev.live.kind === "pending" ? "error" : prev.live.kind,
            phaseLabel: prev.live.kind === "pending" ? "Timeout" : prev.live.phaseLabel,
            detail:
              prev.live.kind === "pending"
                ? "Timeout while waiting for a terminal task state. The task may still complete later on-chain."
                : prev.live.detail,
            updatedAt: new Date().toISOString(),
          },
        };
      });
    }
  }

  async function onSubmit() {
    setError(null);
    setResult(null);
    setTaskScheduleResult(null);
    setTaskDetail(null);
    setTaskEvents([]);

    if (!parsedTask) {
      setError("Task JSON is not valid.");
      return;
    }

    if (!currentAccount?.address) {
      setError("Connect an external wallet before submitting the task.");
      return;
    }

    setBusy(true);
    try {
      const { task, normalizedText } = normalizeTaskText(taskText);
      if (normalizedText !== taskText) {
        setTaskText(JSON.stringify(task, null, 2));
      }

      const networkClient = iotaClients[activeNetwork];
      const chain = getChainForOracleNetwork(activeNetwork);
      const startMs = schedulePreview.startMs;
      const budgetNanoIota = parseIotaToNano(scheduleInitialFundsIota);
      if (budgetNanoIota <= 0n) {
        throw new Error("Initial funds must be greater than zero.");
      }

      let quote = budgetQuote;
      if (!quote) {
        const preparedQuote = await prepareWalletTask(task, currentAccount.address, activeNetwork);
        const requiredPerRunNanoIota = BigInt(preparedQuote.requiredPerRun);
        quote = {
          requiredPerRunNanoIota,
          requiredPerRunIotaText: formatNanoIotaToIota(requiredPerRunNanoIota),
        };
        setBudgetQuote(quote);
      }
      const requiredPerRun = quote.requiredPerRunNanoIota;
      if (requiredPerRun <= 0n) {
        throw new Error("Unable to determine the required budget per run for this task.");
      }

      const existingScheduleIds = new Set<string>();
      try {
        const scheduleSnapshot = await fetchTaskSchedules(activeNetwork);
        for (const item of Array.isArray(scheduleSnapshot?.items) ? scheduleSnapshot.items : []) {
          const id = normalizeAddress((item as any)?.id);
          if (id) existingScheduleIds.add(id);
        }
      } catch {
        // non-blocking: fallback extraction can still work without a pre-snapshot
      }

      const intervalMinutesRaw = scheduleIntervalMinutes.trim();
      const hasRecurringInterval = intervalMinutesRaw.length > 0;
      const intervalMinutes = hasRecurringInterval ? Number(intervalMinutesRaw) : MIN_SCHEDULE_INTERVAL_MINUTES;
      if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
        throw new Error("Interval must be a positive number of minutes.");
      }
      if (intervalMinutes < MIN_SCHEDULE_INTERVAL_MINUTES) {
        throw new Error(`Interval must be at least ${MIN_SCHEDULE_INTERVAL_MINUTES} minutes.`);
      }

      const maxRuns = budgetNanoIota / requiredPerRun;
      if (maxRuns <= 0n) {
        throw new Error("Initial funds are lower than the required budget for one run.");
      }

      const endMs = hasRecurringInterval ? schedulePreview.endMs : startMs;
      if (hasRecurringInterval) {
        if (endMs <= startMs) {
          throw new Error(
            "A recurring schedule needs an end time at least one interval after the start, or a budget that covers at least two runs.",
          );
        }
        if (maxRuns < 2n) {
          throw new Error(
            "The current budget covers only one run. Increase the budget or use an empty interval for a one-shot task.",
          );
        }
      }

      const prepared = await prepareWalletTaskSchedule(
        task,
        {
          startScheduleMs: startMs,
          endScheduleMs: endMs,
          intervalMinutes,
          initialFundsIota: scheduleInitialFundsIota,
        },
        currentAccount.address,
        activeNetwork,
      );
      const signed = await signTransaction({
        transaction: prepared.serializedTransaction,
        chain,
      });
      const execution = await networkClient.executeTransactionBlock({
        transactionBlock: signed.bytes,
        signature: signed.signature,
        options: {
          showRawEffects: true,
          showEffects: true,
          showObjectChanges: true,
          showEvents: true,
        },
      });
      const digest = String(execution?.digest ?? "").trim();
      const confirmedExecution = await fetchExecutionForDigest(networkClient, digest, execution);
      const taskId =
        extractCreatedTaskId(confirmedExecution) ||
        extractCreatedTaskId(execution) ||
        (await findScheduledTaskIdByRegistry({
          network: activeNetwork,
          creator: currentAccount.address,
          prepared,
          existingIds: existingScheduleIds,
        })) ||
        null;

      setTaskScheduleResult({
        prepared,
        digest,
        taskId,
      });
      onExecuted();
    } catch (err) {
      setError(formatUserFacingError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card task-card">
      <div className="section-title">Create a scheduled task</div>
      <div className="task-intro">
        Every task is now created as a scheduled task. By default it runs once immediately; if you set an interval,
        budget and end date stay in sync so you can drive the schedule from either side.
      </div>

      <div className="task-toolbar task-toolbar-grid">
        <label>
          Task config examples (JSON)
          <select value={selectedExample} onChange={(e) => void onLoadExample(e.target.value)}>
            <option value="">Select...</option>
            {examples.map((example) => (
              <option key={example.path} value={example.name}>
                {example.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Upload custom task config (JSON)
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => void onFileChange(e.target.files?.[0] ?? null)}
          />
        </label>
      </div>

      <div className="wallet-hint-row">
        <span className={`badge ${currentAccount ? "badge-ok" : "badge-muted"}`}>
          {currentAccount ? "wallet connected" : "wallet required"}
        </span>
        <span className="wallet-hint-text mono">
          {currentAccount?.address ?? "Connect a wallet to sign the transaction."}
        </span>
      </div>

      <textarea
        className="task-editor"
        value={taskText}
        onChange={(e) => setTaskText(e.target.value)}
        spellCheck={false}
      />

      <div className="schedule-form-grid">
        <label className="schedule-field">
          Start schedule
          <input
            type="datetime-local"
            value={scheduleStart}
            onChange={(e) => setScheduleStart(normalizeScheduleInputValue(e.target.value))}
          />
          <small>The start is minute-aligned automatically, but you can move it into the future.</small>
        </label>

        <label className="schedule-field">
          End schedule
          <input
            type="datetime-local"
            value={scheduleEnd}
            onChange={(e) => {
              setScheduleSyncSource("end");
              setScheduleEnd(normalizeScheduleInputValue(e.target.value));
            }}
          />
          <small>
            {recurringIntervalMinutes != null
              ? "Edit the end to auto-calculate the required budget, or edit the budget to recalculate the end."
              : "If no interval is set, start and end coincide so the task runs once."}
          </small>
        </label>

        <label className="schedule-field">
          Interval (minutes)
          <input
            type="number"
            min={String(MIN_SCHEDULE_INTERVAL_MINUTES)}
            step="1"
            value={scheduleIntervalMinutes}
            onChange={(e) => setScheduleIntervalMinutes(e.target.value)}
            placeholder="-"
          />
          <small>
            Leave empty for a one-shot run. If set, the minimum supported interval is 5 minutes and budget/end stay
            synchronized.
          </small>
        </label>

        <label className="schedule-field">
          Budget (IOTA)
          <input
            type="number"
            min="0"
            step={budgetStepIota}
            inputMode="decimal"
            key={budgetStepIota}
            value={scheduleInitialFundsIota}
            onChange={(e) => {
              setScheduleSyncSource("budget");
              setScheduleInitialFundsIota(e.target.value);
            }}
          />
          <small>
            Cost per run:{" "}
            <span className="mono">{budgetQuote ? `${budgetQuote.requiredPerRunIotaText} IOTA` : "-"}</span>{" "}
            <span className="summary-hint">(scaled by requested nodes)</span>
            {schedulePreview.possibleRuns != null ? (
              <>
                {" "}
                | possible runs: <span className="mono">{schedulePreview.possibleRuns.toString()}</span>
              </>
            ) : null}
            {budgetQuoteError ? (
              <>
                {" "}
                | <span className="error-inline">{budgetQuoteError}</span>
              </>
            ) : null}
          </small>
        </label>
      </div>

      <div className="task-actions task-actions-mobile">
        <button
          className="wallet-submit-button"
          onClick={() => void onSubmit()}
          disabled={busy || !parsedTask || !currentAccount}
        >
          {busy ? "Opening wallet..." : "Sign and create scheduled task"}
        </button>
        {!parsedTask ? <span className="error-inline">Invalid JSON</span> : null}
      </div>

      {error ? <div className="alert alert-error">{error}</div> : null}

      {taskScheduleResult ? (
        <div className="result-grid">
          <div className="task-summary-grid">
            <div className="task-summary-card">
              <div className="summary-label">Task id</div>
              <div className="summary-value mono">
                {taskScheduleResult.taskId ? shortAddress(taskScheduleResult.taskId, 14, 10) : "Pending extraction"}
              </div>
              <div className="summary-hint mono full-value">{taskScheduleResult.taskId ?? "-"}</div>
            </div>
            <div className="task-summary-card">
              <div className="summary-label">Tx digest</div>
              <div className="summary-value mono">{shortAddress(taskScheduleResult.digest, 10, 8)}</div>
              <div className="summary-hint mono full-value">{taskScheduleResult.digest || "-"}</div>
            </div>
            <div className="task-summary-card">
              <div className="summary-label">Schedule</div>
              <div className="summary-value">
                {Number(taskScheduleResult.prepared.schedule.endScheduleMs) ===
                Number(taskScheduleResult.prepared.schedule.startScheduleMs)
                  ? "one run"
                  : `every ${Math.max(1, Math.floor(Number(taskScheduleResult.prepared.schedule.intervalMs) / 60000))} min`}
              </div>
              <div className="summary-hint">
                Budget: <span className="mono">{taskScheduleResult.prepared.initialFunds}</span> nano-IOTA
              </div>
            </div>
            <button
              type="button"
              className="task-summary-card task-summary-card-button task-summary-card-button-primary"
              onClick={onOpenScheduledTasks}
            >
              <span className="task-summary-card-button-text">Go to schedule list</span>
            </button>
          </div>

          <div className="template-details-card">
            <div className="template-details-head">
              <div className="template-details-title">Task schedule created</div>
              <span className="template-status-badge is-on">active</span>
            </div>
            <div className="template-details-grid">
              <div className="template-kv-item">
                <div className="template-kv-label">Template</div>
                <div className="template-kv-value">
                  {taskScheduleResult.prepared.template.templateId} - {taskScheduleResult.prepared.template.taskType}
                </div>
              </div>
              <div className="template-kv-item">
                <div className="template-kv-label">Required per run</div>
                <div className="template-kv-value mono">{taskScheduleResult.prepared.requiredPerRun}</div>
              </div>
              <div className="template-kv-item">
                <div className="template-kv-label">Start</div>
                <div className="template-kv-value">
                  {new Date(Number(taskScheduleResult.prepared.schedule.startScheduleMs)).toLocaleString()}
                </div>
              </div>
              <div className="template-kv-item">
                <div className="template-kv-label">End</div>
                <div className="template-kv-value">
                  {taskScheduleResult.prepared.schedule.endScheduleMs === "0"
                    ? "Open-ended"
                    : new Date(Number(taskScheduleResult.prepared.schedule.endScheduleMs)).toLocaleString()}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="result-grid">
          <div className="task-summary-grid">
            <div className="task-summary-card">
              <div className="summary-label">Task</div>
              <div className="summary-value mono">{shortAddress(result.taskId, 14, 10)}</div>
              <div className="summary-hint mono full-value">{result.taskId}</div>
            </div>
            <div className="task-summary-card">
              <div className="summary-label">Tx digest</div>
              <div className="summary-value mono">{shortAddress(result.digest, 10, 8)}</div>
              <div className="summary-hint mono full-value">{result.digest || "-"}</div>
            </div>
            <div className="task-summary-card">
              <div className="summary-label">Template</div>
              <div className="summary-value">
                {result.prepared.template.templateId} - {result.prepared.template.taskType}
              </div>
              <div className="summary-hint">
                Sender: <span className="mono">{shortAddress(result.prepared.sender, 10, 8)}</span>
              </div>
            </div>
          </div>

          <div className="task-status-panel">
            <div className="task-status-head">
              <div>
                <div className="subsection-title">Task status</div>
                <div className="task-status-detail">{result.live.detail}</div>
              </div>
            </div>

            <table className="task-status-table" role="presentation">
              <tbody>
                <tr>
                  <td className="task-status-table-cell task-status-table-metrics" style={{ verticalAlign: "top" }}>
                    <dl className="result-list compact-result-list task-status-metrics">
                      <div>
                        <dt>On-chain state</dt>
                        <dd>{result.live.state == null ? "-" : String(result.live.state)}</dd>
                      </div>
                      <div>
                        <dt>Round</dt>
                        <dd>{String(result.live.round)}</dd>
                      </div>
                      <div>
                        <dt>Mediation</dt>
                        <dd>
                          attempts={result.live.mediationAttempts}, status={result.live.mediationStatus}, variance=
                          {result.live.mediationVariance}
                        </dd>
                      </div>
                      {result.live.kind === "failed" && failureReason ? (
                        <div>
                          <dt>Failure reason</dt>
                          <dd>
                            {failureReason.label} ({failureReason.code})
                          </dd>
                        </div>
                      ) : null}
                      <div>
                        <dt>Updated</dt>
                        <dd>{new Date(result.live.updatedAt).toLocaleString()}</dd>
                      </div>
                    </dl>
                  </td>
                  <td className="task-status-table-cell task-status-table-phases">
                    <div className="task-phase-stack" aria-label="Task protocol phases">
                      {buildProtocolStages(result.live, protocolStageState).map((stage) => (
                        <span
                          key={stage.key}
                          className={`phase-chip ${stage.active ? "phase-chip-active" : ""} ${stage.completed ? "phase-chip-completed" : ""} ${stage.tone === "success" ? "phase-chip-success" : ""} ${stage.tone === "danger" ? "phase-chip-danger" : ""}`}
                        >
                          {stage.label}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            {result.live.kind === "failed" && failureReason ? (
              <div className="summary-hint">{failureReason.description}</div>
            ) : null}
            {missingCommitNodes.length ? (
              <div className="summary-hint">
                Missing commit before deadline:{" "}
                {missingCommitNodes.map((item) => item.validatorLabel || shortAddress(item.address, 10, 8)).join(", ")}
              </div>
            ) : null}
          </div>

          {result.live.noCommitMessages.length ? (
            <div>
              <div className="subsection-title">No commit messages</div>
              <div className="table-wrap">
                <table className="responsive-table">
                  <thead>
                    <tr>
                      <th>Node</th>
                      <th>Round</th>
                      <th>Reason</th>
                      <th>Message</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.live.noCommitMessages.map((item, index) => (
                      <tr key={`${item.txDigest || item.sender}-${index}`}>
                        <td data-label="Node">
                          {(() => {
                            const nodeMeta = nodeMetaByAddress.get(normalizeAddress(item.sender));
                            return (
                              <>
                                <div className="mono" title={item.sender || undefined}>
                                  {shortAddress(item.sender, 10, 8)}
                                </div>
                                <div className="mono full-value" title={item.sender || undefined}>
                                  oracle: {item.sender || "-"}
                                </div>
                                {nodeMeta?.validatorLabel ? (
                                  <div title={nodeMeta.validatorId || undefined}>
                                    validator: {nodeMeta.validatorLabel}
                                  </div>
                                ) : null}
                              </>
                            );
                          })()}
                        </td>
                        <td data-label="Round">{item.round}</td>
                        <td data-label="Reason">{item.reasonCode || "-"}</td>
                        <td data-label="Message">{item.message || "-"}</td>
                        <td data-label="Updated">
                          {item.timestampMs ? new Date(Number(item.timestampMs)).toLocaleString() : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {assignedNodeRows.length ? (
            <div className="task-status-panel">
              <div className="subsection-title">Assigned nodes</div>
              <div className="table-wrap">
                <table className="responsive-table">
                  <thead>
                    <tr>
                      <th>Node</th>
                      <th>Validator</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assignedNodeRows.map((item) => (
                      <tr key={item.address}>
                        <td data-label="Node">
                          <div className="mono" title={item.address}>
                            {shortAddress(item.address, 10, 8)}
                          </div>
                          <div className="summary-hint mono full-value">{item.address}</div>
                        </td>
                        <td data-label="Validator">
                          {item.validatorLabel ? (
                            <div title={item.validatorId || undefined}>{item.validatorLabel}</div>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td data-label="Status">
                          <span className={`badge ${item.protocolBadge}`}>{item.protocolLabel}</span>
                          {item.protocolHint ? <div className="summary-hint">{item.protocolHint}</div> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {displayResultText ? (
            <div>
              <div className="subsection-title">Task result</div>
              <pre>{displayResultText}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
