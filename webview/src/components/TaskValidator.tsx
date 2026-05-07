// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { useEffect, useMemo, useState } from "react";
import { validateTaskMultisig } from "../lib/multisigValidation";

type RegisteredNode = {
  nodeId?: string | number;
  id?: string | number;
  address?: string;
  pubkey?: unknown;
  acceptedTemplateIds?: Array<string | number>;
};

type TaskLike = {
  id?: string | { id?: string };
  task_id?: string;
  creator?: string;
  multisig_addr?: string;
  multisig_bytes?: unknown;
  assigned_nodes?: Array<string | number>;
  certificate_signers?: Array<string | number>;
  quorum_k?: number | string;
  result?: unknown;
  result_bytes?: number[] | Uint8Array | string | null;
  result_hash?: number[] | Uint8Array | string | null;
  results?: Array<{
    objectId?: string;
    seq?: number | string;
    produced_at_ms?: number | string;
    run_index?: number | string;
    multisig_addr?: string | null;
    multisig_bytes?: unknown;
    certificate_signers?: Array<string | number>;
    result?: unknown;
    result_hash?: number[] | Uint8Array | string | null;
    reason_code?: number | string | null;
    raw?: Record<string, unknown>;
  }>;
  run_history?: Array<{
    run_index?: number | string;
    status?: "OPEN" | "MEDIATION" | "FINALIZED" | "ABORTED" | string;
    submitted_at_ms?: number | string | null;
    completed_at_ms?: number | string | null;
    produced_at_ms?: number | string | null;
    result_seq?: number | string | null;
    reason_code?: number | string | null;
    signer_count?: number | string | null;
    next_run_ms?: number | string | null;
  }>;
};

type TaskEvent = {
  id?: { txDigest?: string; eventSeq?: string } | unknown;
  type?: string;
  sender?: string;
  timestampMs?: string | number | null;
  parsedJson?: Record<string, unknown> | null;
  module?: string;
};

type Props = {
  task: TaskLike | null | undefined;
  registeredNodes: RegisteredNode[];
  events?: TaskEvent[];
};

type EventTone = "ok" | "warn" | "err" | "muted";

type ExplainedEvent = {
  key: string;
  timeLabel: string;
  phase: string;
  title: string;
  description: string;
  summary?: string;
  senderLabel: string;
  senderRole?: string;
  roundLabel: string;
  kindLabel: string;
  tone: EventTone;
  eventTypeLabel: string;
  txDigest: string;
  raw: Record<string, unknown>;
};

function normalizeAddress(value: unknown): string {
  const t = String(value ?? "").trim().toLowerCase();
  if (!t) return "";
  return t.startsWith("0x") ? t : `0x${t}`;
}

function shortAddress(value: unknown): string {
  const addr = normalizeAddress(value);
  if (!addr) return "-";
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function bytesToHex(bytes: Uint8Array | null | undefined): string {
  if (!bytes || bytes.length === 0) return "-";
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().replace(/^0x/i, "");
  if (!clean || clean.length % 2 !== 0) return null;

  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = clean.slice(i * 2, i * 2 + 2);
    const value = Number.parseInt(byte, 16);
    if (Number.isNaN(value)) return null;
    out[i] = value;
  }
  return out;
}

function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

function toUint8Array(value: unknown): Uint8Array | null {
  if (value == null) return null;

  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith("0x") || /^[0-9a-fA-F]+$/.test(trimmed)) {
      return hexToBytes(trimmed);
    }

    return base64ToBytes(trimmed);
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["bytes", "pubkey", "value", "data", "contents"]) {
      if (key in obj) return toUint8Array(obj[key]);
    }
  }

  return null;
}

function decodeAsciiJson(value: unknown): any | null {
  const bytes = toUint8Array(value);
  if (!bytes) return null;

  try {
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function decodeUtf8(value: unknown): string {
  const bytes = toUint8Array(value);
  if (!bytes || bytes.length === 0) return "";
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function decodeResultBytes(value: unknown): Uint8Array | null {
  const bytes = toUint8Array(value);
  return bytes && bytes.length > 0 ? bytes : null;
}

function prettyResultText(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }

  const bytes = decodeResultBytes(value);
  if (bytes) {
    try {
      const text = new TextDecoder().decode(bytes).trim();
      if (!text) return null;
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return text;
      }
    } catch {
      return bytesToHex(bytes);
    }
  }

  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["result", "result_bytes", "bytes", "value", "contents", "data", "raw"]) {
    if (!(key in record)) continue;
    const nested = prettyResultText(record[key]);
    if (nested) return nested;
  }
  return null;
}

function formatProducedAt(value: unknown): string {
  const num = fieldNumber({ value }, "value");
  if (num == null || num <= 0) return "-";
  return new Date(num).toLocaleString();
}

function isMostlyPrintable(text: string): boolean {
  if (!text) return false;
  let printable = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) printable += 1;
  }
  return printable / text.length >= 0.9;
}

function maybeDecodeText(value: unknown): string {
  const text = decodeUtf8(value).trim();
  return isMostlyPrintable(text) ? text : "";
}

function eventTypeName(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const parts = raw.split("::");
  return parts[parts.length - 1] || raw;
}

function fieldNumber(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    const nested = asRecord(value);
    if (nested && (typeof nested.value === "number" || typeof nested.value === "string")) {
      const parsed = Number(nested.value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function fieldString(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    const nested = asRecord(value);
    if (nested && typeof nested.value === "string" && nested.value.trim()) return nested.value.trim();
  }
  return "";
}

function fieldAddress(record: Record<string, unknown>, ...keys: string[]): string {
  const value = fieldString(record, ...keys);
  return normalizeAddress(value);
}

function isZeroAddress(value: unknown): boolean {
  const addr = normalizeAddress(value);
  return !!addr && /^0x0+$/.test(addr);
}

function previewHex(value: unknown, chars = 16): string {
  const bytes = toUint8Array(value);
  if (!bytes || bytes.length === 0) return "";
  const hex = bytesToHex(bytes);
  return hex.length > chars ? `${hex.slice(0, chars)}...` : hex;
}

function singleLinePreview(value: unknown, maxLength = 80): string {
  const pretty = prettyResultText(value) ?? maybeDecodeText(value);
  if (pretty) {
    const compact = pretty.replace(/\s+/g, " ").trim();
    return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
  }

  const hex = previewHex(value, maxLength);
  return hex || "";
}

function describeReasonCode(reasonCode: number): { label: string; description: string; tone: EventTone } {
  switch (reasonCode) {
    case 1:
      return {
        label: "EXECUTION_FAILED",
        description: "The node could not complete task execution locally, so it explicitly opted out of the commit phase.",
        tone: "warn",
      };
    case 1002:
      return {
        label: "COMMIT_TIMEOUT",
        description: "The commit window ended before enough commit messages were received.",
        tone: "err",
      };
    case 1003:
      return {
        label: "REVEAL_NO_QUORUM",
        description: "Nodes revealed different outputs and no winning result reached quorum.",
        tone: "err",
      };
    case 1004:
      return {
        label: "COMMIT_NO_QUORUM",
        description: "Enough nodes declared no_commit, making commit quorum mathematically impossible.",
        tone: "err",
      };
    case 1005:
      return {
        label: "PARTIAL_SIG_TIMEOUT",
        description: "A winning result existed, but the leader did not collect enough partial signatures to finalize.",
        tone: "err",
      };
    default:
      return {
        label: reasonCode > 0 ? `REASON_${reasonCode}` : "UNKNOWN_REASON",
        description: "The protocol recorded an abort or failure reason code that is not explicitly mapped in the webview.",
        tone: reasonCode > 0 ? "warn" : "muted",
      };
  }
}

function describeFinalizeMode(mode: number | null): string {
  if (mode == null) return "-";
  if (mode === 1) return "Direct finalize";
  if (mode === 2) return "Finalize after mediation";
  return `Mode ${mode}`;
}

function badgeClass(tone: EventTone): string {
  if (tone === "ok") return "badge badge-ok";
  if (tone === "warn") return "badge badge-warn";
  if (tone === "err") return "badge badge-err";
  return "badge badge-muted";
}

function explainOracleMessage(
  evt: TaskEvent,
  record: Record<string, unknown>,
  leaderAddress: string,
  creatorAddress: string,
): Omit<ExplainedEvent, "key" | "timeLabel" | "senderLabel" | "senderRole" | "roundLabel" | "eventTypeLabel" | "txDigest" | "raw"> {
  const kind = fieldNumber(record, "kind", "message_kind") ?? -1;
  const round = fieldNumber(record, "round");
  const payloadText = maybeDecodeText(record.payload);
  const sender = normalizeAddress(fieldString(record, "sender") || evt.sender || "");

  if (kind === 2) {
    return {
      phase: "Commit",
      title: "Commit published",
      description: "The node commits the hash of its computed result without revealing the underlying value yet.",
      summary: (() => {
        const hashPreview = previewHex(record.payload, 20);
        return hashPreview ? `Committed result hash: ${hashPreview}` : "Hash committed and hidden until reveal phase.";
      })(),
      kindLabel: "COMMIT",
      tone: "muted",
    };
  }

  if (kind === 3) {
    const numericValue = fieldNumber(record, "value0");
    const hasNumeric = fieldNumber(record, "value1");
    const parts: string[] = [];
    const bytes = toUint8Array(record.payload);
    if (bytes?.length) parts.push(`revealed bytes=${bytes.length}`);
    if (hasNumeric === 1 && numericValue != null) parts.push(`numeric value=${numericValue}`);
    return {
      phase: "Reveal",
      title: "Reveal published",
      description: "The node reveals its normalized output so peers can verify the prior commit and compare results.",
      summary: parts.length ? parts.join(" - ") : "Result revealed for cross-checking and hash comparison.",
      kindLabel: "REVEAL",
      tone: "muted",
    };
  }

  if (kind === 4) {
    return {
      phase: "Consensus",
      title: "Partial signature published",
      description: "The node signs the consensus message for the winning result hash. The leader needs at least quorum_k partial signatures to finalize.",
      summary: "This is one of the signatures later aggregated into the final task certificate.",
      kindLabel: "PARTIAL_SIGNATURE",
      tone: "ok",
    };
  }

  if (kind === 5) {
    const finalizeMode = fieldNumber(record, "value0");
    const detailText = payloadText;
    let summary = `Leader intent: ${describeFinalizeMode(finalizeMode)}`;
    if (detailText) {
      const detailJson = (() => {
        try {
          return JSON.parse(detailText) as Record<string, unknown>;
        } catch {
          return null;
        }
      })();
      if (detailJson) {
        const signers = Array.isArray(detailJson.signers) ? detailJson.signers.length : null;
        const hash = typeof detailJson.hash === "string" ? detailJson.hash : "";
        summary = [
          `mode=${describeFinalizeMode(finalizeMode)}`,
          signers != null ? `signers=${signers}` : "",
          hash ? `hash=${hash.slice(0, 16)}...` : "",
        ].filter(Boolean).join(" - ");
      } else {
        summary = detailText.length > 140 ? `${detailText.slice(0, 140)}...` : detailText;
      }
    }
    return {
      phase: "Finalization",
      title: "Leader finalize intent",
      description: "The leader announces the result it intends to finalize and the signer set used for the certificate.",
      summary,
      kindLabel: "LEADER_INTENT",
      tone: sender && sender === leaderAddress ? "ok" : "warn",
    };
  }

  if (kind === 6) {
    const reasonCode = fieldNumber(record, "value0") ?? 0;
    const reason = describeReasonCode(reasonCode);
    return {
      phase: "Abort",
      title: "Abort intent",
      description: "A node announced an explicit abort intent for the current round instead of proceeding toward finalization.",
      summary: `${reason.label} - ${reason.description}`,
      kindLabel: "ABORT_INTENT",
      tone: reason.tone,
    };
  }

  if (kind === 7) {
    const reasonCode = fieldNumber(record, "value0") ?? 0;
    const reason = describeReasonCode(reasonCode);
    const parts = [reason.label];
    if (payloadText) parts.push(payloadText);
    return {
      phase: "Commit",
      title: "No commit",
      description: "The node declares that it cannot publish a valid commit for this round, so the protocol excludes it from the commit quorum count.",
      summary: parts.join(" - "),
      kindLabel: "NO_COMMIT",
      tone: reason.tone,
    };
  }

  return {
    phase: "Messages",
    title: evt.type ? eventTypeName(evt.type) : "Oracle message",
    description: "Raw oracle message detected, but its kind is not mapped to a specific protocol explanation.",
    summary: round != null ? `round=${round}` : undefined,
    kindLabel: kind >= 0 ? `MESSAGE_${kind}` : "MESSAGE",
    tone: sender && sender === creatorAddress ? "warn" : "muted",
  };
}

function explainTaskLifecycle(
  evt: TaskEvent,
  record: Record<string, unknown>,
): Omit<ExplainedEvent, "key" | "timeLabel" | "senderLabel" | "senderRole" | "roundLabel" | "eventTypeLabel" | "txDigest" | "raw"> {
  const typeName = eventTypeName(evt.type);

  if (typeName === "TaskCreated") {
    const templateId = fieldNumber(record, "template_id");
    const payment = fieldString(record, "payment_iota");
    return {
      phase: "Creation",
      title: "Task created",
      description: "The task has been created on-chain and funded, so it can enter the oracle workflow.",
      summary: [templateId != null ? `template=${templateId}` : "", payment ? `payment=${payment}` : ""].filter(Boolean).join(" - ") || undefined,
      kindLabel: "TASK_CREATED",
      tone: "ok",
    };
  }

  if (typeName === "TaskAssigned") {
    const to = fieldAddress(record, "to", "addr0");
    return {
      phase: "Dispatch",
      title: "Task assigned",
      description: "The protocol assigns the task to one oracle node for the current round.",
      summary: to ? `assigned to ${shortAddress(to)}` : undefined,
      kindLabel: "TASK_ASSIGNED",
      tone: "ok",
    };
  }

  if (typeName === "TaskCommitSigSubmitted") {
    const count = fieldNumber(record, "commit_count");
    const requested = fieldNumber(record, "requested_nodes");
    return {
      phase: "Commit",
      title: "Commit recorded",
      description: "A node has entered the commit phase and the protocol has counted its hidden result commitment.",
      summary: count != null && requested != null ? `commit_count=${count}/${requested}` : undefined,
      kindLabel: "TASK_COMMIT_RECORDED",
      tone: "muted",
    };
  }

  if (typeName === "CommitPhaseClosed") {
    const deadline = fieldNumber(record, "reveal_deadline_ms");
    return {
      phase: "Reveal",
      title: "Commit phase closed",
      description: "The commit window is closed. From this point, nodes can reveal their actual outputs.",
      summary: deadline != null ? `reveal deadline: ${new Date(deadline).toLocaleString()}` : undefined,
      kindLabel: "COMMIT_PHASE_CLOSED",
      tone: "ok",
    };
  }

  if (typeName === "TaskRevealSubmitted") {
    return {
      phase: "Reveal",
      title: "Reveal recorded",
      description: "A node has revealed its output, allowing the protocol to compare results and identify a winning hash.",
      summary: (() => {
        const preview = previewHex(record.result_hash, 20);
        return preview ? `result hash=${preview}` : undefined;
      })(),
      kindLabel: "TASK_REVEAL_RECORDED",
      tone: "muted",
    };
  }

  if (typeName === "TaskPartialSigSubmitted") {
    return {
      phase: "Consensus",
      title: "Partial signature recorded",
      description: "A node has contributed a partial signature toward the final multisig certificate.",
      summary: (() => {
        const preview = previewHex(record.result_hash, 20);
        return preview ? `result hash=${preview}` : undefined;
      })(),
      kindLabel: "TASK_PARTIAL_SIG_RECORDED",
      tone: "ok",
    };
  }

  if (typeName === "TaskDataRequested") {
    const failedRound = fieldNumber(record, "failed_round");
    const deadline = fieldNumber(record, "data_deadline_ms");
    return {
      phase: "Mediation",
      title: "Raw data requested",
      description: "Consensus was not reached on the first reveal set, so nodes are asked to provide raw data for mediation.",
      summary: [
        failedRound != null ? `failed round=${failedRound}` : "",
        deadline != null ? `data deadline=${new Date(deadline).toLocaleString()}` : "",
      ].filter(Boolean).join(" - ") || undefined,
      kindLabel: "TASK_DATA_REQUESTED",
      tone: "warn",
    };
  }

  if (typeName === "TaskDataSubmitted") {
    const count = fieldNumber(record, "data_count");
    const requested = fieldNumber(record, "requested_nodes");
    return {
      phase: "Mediation",
      title: "Raw data submitted",
      description: "A node has submitted its raw result data so the leader can attempt mediation.",
      summary: count != null && requested != null ? `data_count=${count}/${requested}` : undefined,
      kindLabel: "TASK_DATA_SUBMITTED",
      tone: "warn",
    };
  }

  if (typeName === "TaskCompletedNoConsensus") {
    const count = fieldNumber(record, "data_count");
    const requested = fieldNumber(record, "requested_nodes");
    return {
      phase: "Abort",
      title: "Completed without consensus",
      description: "The task exhausted the current resolution path without producing a valid consensus result.",
      summary: count != null && requested != null ? `data_count=${count}/${requested}` : undefined,
      kindLabel: "TASK_COMPLETED_NO_CONSENSUS",
      tone: "err",
    };
  }

  if (typeName === "TaskMediationStarted") {
    const variance = fieldNumber(record, "variance");
    const varianceMax = fieldNumber(record, "variance_max");
    const fromRound = fieldNumber(record, "from_round");
    const toRound = fieldNumber(record, "to_round");
    return {
      phase: "Mediation",
      title: "Mediation started",
      description: "The leader opened a new mediation round to reconcile different numeric results using the configured variance threshold.",
      summary: [
        fromRound != null ? `from round=${fromRound}` : "",
        toRound != null ? `to round=${toRound}` : "",
        variance != null ? `variance=${variance}` : "",
        varianceMax != null ? `max=${varianceMax}` : "",
      ].filter(Boolean).join(" - ") || undefined,
      kindLabel: "TASK_MEDIATION_STARTED",
      tone: "warn",
    };
  }

  if (typeName === "TaskMediationBlocked") {
    const variance = fieldNumber(record, "variance");
    const varianceMax = fieldNumber(record, "variance_max");
    return {
      phase: "Mediation",
      title: "Mediation blocked",
      description: "Mediation could not start because the observed variance was outside the allowed threshold.",
      summary: [variance != null ? `variance=${variance}` : "", varianceMax != null ? `max=${varianceMax}` : ""].filter(Boolean).join(" - ") || undefined,
      kindLabel: "TASK_MEDIATION_BLOCKED",
      tone: "err",
    };
  }

  if (typeName === "TaskFailed") {
    const reasonCode = fieldNumber(record, "reason_code") ?? 0;
    const reason = describeReasonCode(reasonCode);
    return {
      phase: "Abort",
      title: "Task failed",
      description: "The task has been closed in failed state by the protocol.",
      summary: `${reason.label} - ${reason.description}`,
      kindLabel: "TASK_FAILED",
      tone: reason.tone,
    };
  }

  if (typeName === "TaskCompleted") {
    const quorumK = fieldNumber(record, "quorum_k");
    const multisig = fieldAddress(record, "multisig_addr");
    return {
      phase: "Finalization",
      title: "Task finalized",
      description: "The task has been finalized on-chain with a certificate and a multisig address tied to the agreed result.",
      summary: [quorumK != null ? `quorum=${quorumK}` : "", multisig ? `multisig=${shortAddress(multisig)}` : ""].filter(Boolean).join(" - ") || undefined,
      kindLabel: "TASK_COMPLETED",
      tone: "ok",
    };
  }

  if (typeName === "TaskLifecycleEvent") {
    const kind = fieldNumber(record, "kind");
    const addr0 = fieldAddress(record, "addr0", "to");

    if (kind === 2 && addr0 && !isZeroAddress(addr0)) {
      return {
        phase: "Dispatch",
        title: "Task assigned",
        description: "A lifecycle event indicates that the task was assigned to a specific node for processing.",
        summary: `assigned to ${shortAddress(addr0)}`,
        kindLabel: "TASK_ASSIGNED",
        tone: "ok",
      };
    }

    if (kind === 10) {
      const templateId = fieldNumber(record, "value0", "template_id");
      const requestedNodes = fieldNumber(record, "value1", "requested_nodes");
      const payment = fieldString(record, "value2", "payment_iota");
      const retentionDays = fieldNumber(record, "value3", "retention_days");
      return {
        phase: "Dispatch",
        title: "Task dispatched",
        description: "This lifecycle event records the task entering the oracle workflow with its main execution parameters. It is a task-level dispatch snapshot, not an assignment to a specific node.",
        summary: [
          templateId != null ? `template=${templateId}` : "",
          requestedNodes != null ? `requested_nodes=${requestedNodes}` : "",
          payment ? `payment=${payment}` : "",
          retentionDays != null ? `retention_days=${retentionDays}` : "",
        ].filter(Boolean).join(" - ") || undefined,
        kindLabel: "TASK_DISPATCHED",
        tone: "muted",
      };
    }

    if (kind === 9 && addr0 && !isZeroAddress(addr0)) {
      const stateCode = fieldNumber(record, "value0");
      const requestedNodes = fieldNumber(record, "value1", "requested_nodes");
      const quorumK = fieldNumber(record, "value2", "quorum_k");
      const payloadBytes = fieldNumber(record, "value3", "payload_bytes");
      const stateLabel = stateCode === 1 ? "commit" : stateCode != null ? `state ${stateCode}` : undefined;
      return {
        phase: "Dispatch",
        title: "Assignment target recorded",
        description: "This lifecycle event records one node included in the assignment set for the task. The address is the selected node, while the numeric fields snapshot the execution parameters attached to that assignment.",
        summary: [
          `node=${shortAddress(addr0)}`,
          stateLabel ? `phase=${stateLabel}` : "",
          requestedNodes != null ? `requested_nodes=${requestedNodes}` : "",
          quorumK != null ? `quorum=${quorumK}` : "",
          payloadBytes != null ? `payload_bytes=${payloadBytes}` : "",
        ].filter(Boolean).join(" - ") || undefined,
        kindLabel: "TASK_ASSIGNMENT_TARGET",
        tone: "ok",
      };
    }

    if (kind === 4 || fieldNumber(record, "data_deadline_ms") != null) {
      return {
        phase: "Mediation",
        title: "Raw data requested",
        description: "A lifecycle event indicates that the task moved to raw-data collection for mediation.",
        summary: (() => {
          const deadline = fieldNumber(record, "data_deadline_ms", "value0");
          return deadline != null ? `data deadline=${new Date(deadline).toLocaleString()}` : undefined;
        })(),
        kindLabel: "TASK_DATA_REQUESTED",
        tone: "warn",
      };
    }
    if (kind === 6 || fieldNumber(record, "variance_max") != null) {
      return {
        phase: "Mediation",
        title: "Mediation started",
        description: "A lifecycle event indicates that the protocol started a mediation round.",
        summary: (() => {
          const variance = fieldNumber(record, "value1", "variance");
          const varianceMax = fieldNumber(record, "value2", "variance_max");
          return [variance != null ? `variance=${variance}` : "", varianceMax != null ? `max=${varianceMax}` : ""].filter(Boolean).join(" - ") || undefined;
        })(),
        kindLabel: "TASK_MEDIATION_STARTED",
        tone: "warn",
      };
    }
  }

  return {
    phase: "Task events",
    title: typeName || "Task event",
    description: "This on-chain event belongs to the task lifecycle, but the webview does not have a dedicated explanation for its schema yet.",
    summary: undefined,
    kindLabel: typeName ? typeName.toUpperCase() : "TASK_EVENT",
    tone: "muted",
  };
}

function explainEvent(
  evt: TaskEvent,
  task: TaskLike | null | undefined,
  registeredNodes: RegisteredNode[],
): ExplainedEvent {
  const raw = asRecord(evt.parsedJson) ?? {};
  const assignedNodes = Array.isArray(task?.assigned_nodes)
    ? task?.assigned_nodes.map((item) => normalizeAddress(item)).filter(Boolean)
    : [];
  const leaderAddress = [...assignedNodes].sort()[0] ?? "";
  const creatorAddress = normalizeAddress(task?.creator);
  const sender = normalizeAddress(fieldString(raw, "sender") || evt.sender || "");
  const round = fieldNumber(raw, "round", "failed_round", "from_round", "to_round");
  const typeName = eventTypeName(evt.type);
  const isOracleMessage = typeName === "OracleMessage" || fieldNumber(raw, "message_kind") != null || (fieldNumber(raw, "kind") != null && ("payload" in raw || "signature" in raw));

  const explained = isOracleMessage
    ? explainOracleMessage(evt, raw, leaderAddress, creatorAddress)
    : explainTaskLifecycle(evt, raw);

  const knownNode = registeredNodes.find((node) => normalizeAddress(node.address) === sender);
  const senderRole = sender
    ? sender === leaderAddress
      ? "leader"
      : assignedNodes.includes(sender)
        ? "assigned node"
        : sender === creatorAddress
          ? "creator"
          : knownNode
            ? "registered node"
            : undefined
    : undefined;

  return {
    key: `${String((evt.id as any)?.txDigest ?? "")}:${String((evt.id as any)?.eventSeq ?? "")}:${typeName}:${round ?? "-"}`,
    timeLabel: evt.timestampMs ? new Date(Number(evt.timestampMs)).toLocaleString() : "-",
    senderLabel: sender ? shortAddress(sender) : "-",
    senderRole,
    roundLabel: round != null ? String(round) : "-",
    eventTypeLabel: typeName || "-",
    txDigest: String((evt.id as any)?.txDigest ?? ""),
    raw,
    ...explained,
  };
}

export default function TaskValidator({ task, registeredNodes, events = [] }: Props) {
  const results = useMemo(
    () =>
      (Array.isArray(task?.results) ? task.results : [])
        .slice()
        .sort((a, b) => {
          const producedA = fieldNumber({ value: a?.produced_at_ms }, "value") ?? -1;
          const producedB = fieldNumber({ value: b?.produced_at_ms }, "value") ?? -1;
          if (producedB !== producedA) return producedB - producedA;
          const seqA = fieldNumber({ value: a?.seq }, "value") ?? -1;
          const seqB = fieldNumber({ value: b?.seq }, "value") ?? -1;
          return seqB - seqA;
        }),
    [task?.results],
  );
  const runHistory = useMemo(
    () =>
      (Array.isArray(task?.run_history) ? task.run_history : [])
        .slice()
        .sort((a, b) => {
          const runA = fieldNumber({ value: a?.run_index }, "value") ?? -1;
          const runB = fieldNumber({ value: b?.run_index }, "value") ?? -1;
          return runB - runA;
        }),
    [task?.run_history],
  );
  const [selectedResultKey, setSelectedResultKey] = useState("");

  useEffect(() => {
    if (!results.length) {
      setSelectedResultKey("");
      return;
    }
    const hasCurrentSelection = results.some(
      (item, index) => `${item.objectId || ""}:${item.seq ?? "-"}:${index}` === selectedResultKey,
    );
    if (!hasCurrentSelection) {
      setSelectedResultKey(`${results[0].objectId || ""}:${results[0].seq ?? "-"}:0`);
    }
  }, [results, selectedResultKey]);

  const selectedResult = useMemo(() => {
    if (!results.length) return null;
    return (
      results.find(
        (item, index) => `${item.objectId || ""}:${item.seq ?? "-"}:${index}` === selectedResultKey,
      ) ?? results[0]
    );
  }, [results, selectedResultKey]);

  const validationTask = useMemo<TaskLike | null>(() => {
    if (!task) return null;
    if (!selectedResult) return task;
    return {
      ...task,
      multisig_addr: selectedResult.multisig_addr ?? task.multisig_addr,
      multisig_bytes: selectedResult.multisig_bytes ?? task.multisig_bytes,
      certificate_signers: selectedResult.certificate_signers ?? task.certificate_signers,
      result: selectedResult.result ?? task.result,
      result_hash: selectedResult.result_hash ?? task.result_hash,
    };
  }, [task, selectedResult]);

  const validation = useMemo(() => validateTaskMultisig(validationTask, registeredNodes), [validationTask, registeredNodes]);
  const latestResultText = useMemo(
    () =>
      prettyResultText(selectedResult?.result) ??
      prettyResultText(task?.result) ??
      prettyResultText(task?.result_bytes),
    [selectedResult, task?.result, task?.result_bytes],
  );

  const signerOutputPreviewByAddress = useMemo(() => {
    const byAddress = new Map<string, { preview: string; timestamp: number }>();
    const selectedProducedAt = fieldNumber({ value: selectedResult?.produced_at_ms }, "value");

    for (const evt of events ?? []) {
      const raw = asRecord(evt.parsedJson);
      if (!raw || eventTypeName(evt.type) !== "OracleMessage") continue;

      const kind = fieldNumber(raw, "kind", "message_kind");
      if (kind !== 3) continue;

      const sender = normalizeAddress(fieldString(raw, "sender") || evt.sender || "");
      if (!sender) continue;

      const timestamp = fieldNumber({ value: evt.timestampMs }, "value") ?? 0;
      if (selectedProducedAt != null && selectedProducedAt > 0 && timestamp > selectedProducedAt) continue;

      const preview = singleLinePreview(raw.payload, 96);
      if (!preview) continue;

      const current = byAddress.get(sender);
      if (!current || timestamp >= current.timestamp) {
        byAddress.set(sender, { preview, timestamp });
      }
    }

    if (byAddress.size > 0 || selectedProducedAt == null || selectedProducedAt <= 0) return byAddress;

    for (const evt of events ?? []) {
      const raw = asRecord(evt.parsedJson);
      if (!raw || eventTypeName(evt.type) !== "OracleMessage") continue;

      const kind = fieldNumber(raw, "kind", "message_kind");
      if (kind !== 3) continue;

      const sender = normalizeAddress(fieldString(raw, "sender") || evt.sender || "");
      if (!sender) continue;

      const timestamp = fieldNumber({ value: evt.timestampMs }, "value") ?? 0;
      const preview = singleLinePreview(raw.payload, 96);
      if (!preview) continue;

      const current = byAddress.get(sender);
      if (!current || timestamp >= current.timestamp) {
        byAddress.set(sender, { preview, timestamp });
      }
    }

    return byAddress;
  }, [events, selectedResult?.produced_at_ms]);

  const explainedEvents = useMemo(
    () => (events ?? []).map((evt) => explainEvent(evt, task, registeredNodes)),
    [events, task, registeredNodes],
  );

  return (
    <section className="card">
      <div className="section-title">Validate task</div>

      <div className="table-wrap">
        <table className="responsive-table">
          <tbody>
            <tr>
              <td>Stored multisig address</td>
              <td>{validation.storedAddress || "-"}</td>
            </tr>
            <tr>
              <td>Derived from assigned nodes + quorum</td>
              <td>{validation.derivedAddress || "-"}</td>
            </tr>
            <tr>
              <td>Address validation</td>
              <td>
                {!validation.storedAddress && !validation.derivedAddress
                  ? "-"
                  : validation.addressStatus === "unverifiable"
                    ? "NOT VERIFIABLE"
                  : validation.addressStatus === "match"
                  ? "VALID"
                  : validation.addressStatus === "stored_is_signer"
                    ? "WARNING - stored multisig_addr matches a signer address, not the derived multisig address"
                    : "INVALID"}
              </td>
            </tr>
            <tr>
              <td>Result hash</td>
              <td>{validation.resultHashHex || "-"}</td>
            </tr>
            <tr>
              <td>Certificate validation</td>
              <td>
                {validation.certificateStatus === "valid"
                  ? "VALID"
                  : validation.certificateStatus === "below_quorum"
                    ? "INVALID - signers below quorum_k"
                    : validation.certificateStatus === "unknown_signer"
                      ? "INVALID - signer outside assigned node set"
                      : validation.certificateStatus === "duplicate_signer"
                        ? "INVALID - duplicate signer"
                        : "-"}
              </td>
            </tr>
            <tr>
              <td>multisig_bytes</td>
              <td>
                {validation.multisigDebug ? (
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                    {JSON.stringify(validation.multisigDebug, null, 2)}
                  </pre>
                ) : validation.multisigBytesBase64 ? (
                  <div>
                    <div style={{ marginBottom: 8 }}>{validation.multisigBytesLength} bytes</div>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                      {validation.multisigBytesBase64}
                    </pre>
                  </div>
                ) : (
                  "-"
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {validation.derivedError ? (
        <div className="alert alert-warn" style={{ marginTop: 12 }}>
          {validation.derivedError}
        </div>
      ) : null}

      {runHistory.length > 0 ? (
        <>
          <div className="subsection-title" style={{ marginTop: 18 }}>
            Run history
          </div>

          <div className="table-wrap table-wrap-wide">
            <table className="responsive-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Submitted</th>
                  <th>Completed</th>
                  <th>Produced</th>
                  <th>Result seq</th>
                  <th>Signers</th>
                  <th>Reason</th>
                  <th>Next run</th>
                </tr>
              </thead>
              <tbody>
                {runHistory.map((entry, index) => {
                  const status = String(entry.status ?? "UNKNOWN").toUpperCase();
                  const reasonCode = fieldNumber({ value: entry.reason_code }, "value");
                  const reason =
                    reasonCode != null && reasonCode > 0 ? describeReasonCode(reasonCode).label : "-";
                  const tone: EventTone =
                    status === "FINALIZED"
                      ? "ok"
                      : status === "ABORTED"
                        ? "err"
                        : status === "MEDIATION"
                          ? "warn"
                          : "muted";
                  return (
                    <tr key={`${entry.run_index ?? "run"}:${index}`}>
                      <td>{entry.run_index ?? "-"}</td>
                      <td>
                        <span className={badgeClass(tone)}>{status}</span>
                      </td>
                      <td>{formatProducedAt(entry.submitted_at_ms)}</td>
                      <td>{formatProducedAt(entry.completed_at_ms)}</td>
                      <td>{formatProducedAt(entry.produced_at_ms)}</td>
                      <td>{entry.result_seq ?? "-"}</td>
                      <td>{entry.signer_count ?? "-"}</td>
                      <td>{reason}</td>
                      <td>{formatProducedAt(entry.next_run_ms)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {latestResultText ? (
        <>
          <div className="subsection-title" style={{ marginTop: 18 }}>
            {selectedResult && selectedResult !== results[0] ? "Selected result" : "Latest result"}
          </div>
          {selectedResult ? (
            <div className="summary-hint" style={{ marginBottom: 8 }}>
              Produced at: {formatProducedAt(selectedResult.produced_at_ms)}
              {selectedResult.seq != null ? ` | seq=${selectedResult.seq}` : ""}
              {selectedResult.run_index != null ? ` | run=${selectedResult.run_index}` : ""}
            </div>
          ) : null}
          <pre>{latestResultText}</pre>
        </>
      ) : null}

      {results.length > 0 ? (
        <>
          <div className="subsection-title" style={{ marginTop: 18 }}>
            Result history
          </div>

          <div className="table-wrap table-wrap-wide">
            <table className="responsive-table">
              <thead>
                <tr>
                  <th>Seq</th>
                  <th>Produced at</th>
                  <th>Run</th>
                  <th>Hash</th>
                  <th>Signers</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {results.map((item, index) => {
                  const signers = Array.isArray(item.certificate_signers) ? item.certificate_signers.length : 0;
                  const hash = bytesToHex(toUint8Array(item.result_hash) ?? undefined) || "-";
                  const preview = prettyResultText(item.result);
                  const rowKey = `${item.objectId || ""}:${item.seq ?? "-"}:${index}`;
                  const isSelected = rowKey === selectedResultKey;
                  return (
                    <tr
                      key={item.objectId || `${item.seq ?? "-"}-${index}`}
                      onClick={() => setSelectedResultKey(rowKey)}
                      style={{
                        cursor: "pointer",
                        backgroundColor: isSelected ? "rgba(56, 112, 255, 0.08)" : undefined,
                      }}
                    >
                      <td>{item.seq ?? "-"}</td>
                      <td>{formatProducedAt(item.produced_at_ms)}</td>
                      <td>{item.run_index ?? "-"}</td>
                      <td className="mono" title={hash}>
                        {hash === "-" ? "-" : hash.length > 20 ? `${hash.slice(0, 20)}...` : hash}
                      </td>
                      <td>{signers}</td>
                      <td>
                        <div>{item.reason_code ?? 0}</div>
                        {preview ? <div className="summary-hint">{preview.length > 120 ? `${preview.slice(0, 120)}...` : preview}</div> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <div className="subsection-title" style={{ marginTop: 18 }}>
        Certificate signers
      </div>

      <div className="table-wrap table-wrap-wide">
        <table className="responsive-table">
          <thead>
            <tr>
              <th>Signer</th>
              <th>Found</th>
              <th>Address</th>
              <th>Output preview</th>
              <th>Pubkey</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {validation.signerRows.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  No certificate signers
                </td>
              </tr>
            ) : (
              validation.signerRows.map((row: any) => {
                const previewKey = normalizeAddress(row.address || row.signerId);
                const outputPreview = signerOutputPreviewByAddress.get(previewKey)?.preview || "-";

                return (
                  <tr key={row.signerId}>
                    <td>{row.signerId}</td>
                    <td>{row.found ? "YES" : "NO"}</td>
                    <td>{row.address || "-"}</td>
                    <td title={outputPreview} className="mono">
                      {outputPreview}
                    </td>
                    <td>{row.pubkeyBase64 || "-"}</td>
                    <td>{row.error || "-"}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="subsection-title" style={{ marginTop: 18 }}>
        Task events
      </div>

      {!events || events.length === 0 ? (
        <div className="table-wrap table-wrap-wide">
          <table className="responsive-table">
            <tbody>
              <tr>
                <td className="empty">No events found for this task</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div className="event-timeline">
          {explainedEvents.map((event) => (
            <article key={event.key} className="event-card">
              <div className="event-card-head">
                <div className="event-card-title-wrap">
                  <div className="event-card-title-row">
                    <span className={badgeClass(event.tone)}>{event.phase}</span>
                    <strong className="event-card-title">{event.title}</strong>
                  </div>
                  <div className="event-card-description">{event.description}</div>
                </div>
                <div className="event-card-side">
                  <div className="event-card-time">{event.timeLabel}</div>
                  <div className="event-card-kind mono">{event.kindLabel}</div>
                </div>
              </div>

              {event.summary ? <div className="event-card-summary">{event.summary}</div> : null}

              <div className="event-card-meta">
                <span className="badge badge-muted">sender: {event.senderLabel}</span>
                {event.senderRole ? <span className="badge badge-muted">role: {event.senderRole}</span> : null}
                <span className="badge badge-muted">round: {event.roundLabel}</span>
                <span className="badge badge-muted">type: {event.eventTypeLabel}</span>
              </div>

              <details className="event-raw">
                <summary>Technical payload</summary>
                <div className="event-raw-grid">
                  <div>
                    <div className="event-raw-label">Tx digest</div>
                    <div className="mono">{event.txDigest || "-"}</div>
                  </div>
                  <div>
                    <div className="event-raw-label">Parsed JSON</div>
                    <pre>{JSON.stringify(event.raw, null, 2)}</pre>
                  </div>
                </div>
              </details>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
