// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { optInt, acceptsTemplate } from "../nodeConfig";
import { bytesToUtf8, decodeVecU8 } from "../events";
import { executeTask } from "../taskExec";
import { publishNoCommit } from "../taskSignFlow";
import type { NodeContext } from "../nodeContext";
import { assertCommitteeMultisigAddress, buildMultiSigPublicKey } from "../multisig.js";
import { loadPubkeysByAddrB64 } from "../services/pubkeys";
import { readNodeRegistrySnapshot, readRegisteredOracleNodeByAddr } from "../services/schedulerReader";
import { loadLatestTaskResult, loadTaskBundle, isTaskFreshForNode, taskCreatedAtMs } from "../services/taskObjects";
import { savePersistedAcceptedTemplateIds } from "../templateState";
import { moveToArray, moveToString } from "../utils/move";
import { sleep } from "../utils/sleep";
import {
  abortTaskWithCertificate,
  consensusMessage,
  finalizeTaskWithCertificate,
  publishCommit,
  publishLeaderIntent,
  publishPartialSignature,
  publishReveal,
  startMediation,
} from "../oracleMessages";
import {
  buildCertificateBlob,
  sha256Hex,
  waitForCommitQuorum,
  waitForPartialQuorum,
  waitForRevealResolution,
} from "../services/eventConsensus";
import { extractNumericScale, extractNumericValue, toConsensusU64 } from "../utils/numeric";

function leaderOrder(assigned: string[]): string[] {
  return [...assigned].map((x) => x.toLowerCase()).sort();
}

async function finalizeOrderByNodeId(
  client: NodeContext["client"],
  assigned: string[],
): Promise<string[]> {
  const assignedSet = new Set(assigned.map((x) => x.toLowerCase()).filter(Boolean));
  const registry = await readNodeRegistrySnapshot(client).catch((error) => {
    console.warn(`[finalize] node-id order unavailable, falling back to address order: ${String((error as any)?.message ?? error)}`);
    return null;
  });
  if (!registry) return leaderOrder(assigned);

  const known = registry.nodes
    .filter((node) => assignedSet.has(node.addr))
    .sort((a, b) => a.nodeId - b.nodeId || a.addr.localeCompare(b.addr))
    .map((node) => node.addr);

  const knownSet = new Set(known);
  const unknown = [...assignedSet]
    .filter((addr) => !knownSet.has(addr))
    .sort();

  return [...known, ...unknown];
}

function isLiveExecutionState(state: number): boolean {
  return state === 1 || state === 2;
}

async function waitForOrderedActionTurn(opts: {
  client: NodeContext["client"];
  taskId: string;
  nodeId: string;
  myAddr: string;
  order: string[];
  action: string;
  slotMs: number;
}): Promise<boolean> {
  const { client, taskId, nodeId, myAddr, order, action, slotMs } = opts;
  const actionIndex = order.indexOf(myAddr);
  if (actionIndex < 0) {
    console.warn(`[node ${nodeId}] skip ${action} task=${taskId} reason=not_in_action_order me=${myAddr}`);
    return false;
  }

  const delayMs = actionIndex * Math.max(0, slotMs);
  if (delayMs > 0) {
    console.log(
      `[node ${nodeId}] ${action} backup slot task=${taskId} index=${actionIndex} delay_ms=${delayMs} leader=${order[0] ?? "-"}`,
    );
    await sleep(delayMs);
  }

  const latest = await loadTaskBundle(client, taskId).catch((error) => {
    console.warn(`[node ${nodeId}] ${action} state recheck failed task=${taskId}: ${String((error as any)?.message ?? error)}`);
    return null;
  });
  const latestExecutionState = Number(latest?.taskFields?.execution_state ?? -1);
  if (!isLiveExecutionState(latestExecutionState)) {
    console.log(
      `[node ${nodeId}] skip ${action} task=${taskId} reason=already_closed execution_state=${latestExecutionState}`,
    );
    return false;
  }

  return true;
}

async function deriveAssignedCommitteeMultisigAddress(
  client: NodeContext["client"],
  assignedNodes: string[],
  quorumK: number,
  context: string,
): Promise<string> {
  const pubkeysByAddrB64 = await loadPubkeysByAddrB64(client);
  const assignedSorted = assignedNodes.map((addr) => addr.toLowerCase()).sort();
  const pubsSorted: Array<{ nodeId: string; pubKeyBase64: string }> = [];

  for (const addr of assignedSorted) {
    const pubkeyBase64 = pubkeysByAddrB64.get(addr);
    if (!pubkeyBase64) throw new Error(`Missing pubkey for ${addr}`);
    pubsSorted.push({ nodeId: addr, pubKeyBase64: pubkeyBase64 });
  }

  const multisigAddr = buildMultiSigPublicKey(quorumK, pubsSorted).toIotaAddress();
  return assertCommitteeMultisigAddress({
    threshold: quorumK,
    pubs: pubsSorted,
    multisigAddr,
    context,
  });
}

function truncateForDiagnostic(value: string, max = 180): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function pickTaskTarget(payload: any): string | null {
  const candidates = [
    payload?.request?.url,
    payload?.source?.url,
    payload?.url,
    payload?.source?.kind,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return truncateForDiagnostic(candidate, 220);
    }
  }

  return null;
}

function inferDiagnosticStage(taskType: string, errMsg: string): string {
  const msg = errMsg.toLowerCase();
  if (msg.includes("missing payload.") || msg.includes("missing template_id") || msg.includes("invalid ") || msg.includes("unsupported task type")) {
    return "input_validation";
  }
  if (msg.includes("http ") || msg.includes("timeout") || msg.includes("fetch") || msg.includes("download")) {
    return "input_fetch";
  }
  if (msg.includes("json response") || msg.includes("parse") || msg.includes("schema")) {
    return "parse_or_schema";
  }
  if (msg.includes("ipfs")) {
    return "storage_upload";
  }
  if (msg.includes("llm") || taskType.startsWith("LLM_")) {
    return "llm_call";
  }
  return "task_execute";
}

function inferErrorClass(errMsg: string): string {
  const msg = errMsg.toLowerCase();
  if (msg.includes("timeout")) return "timeout";
  if (msg.includes("http ")) return "http_error";
  if (msg.includes("schema")) return "schema_error";
  if (msg.includes("json")) return "json_error";
  if (msg.includes("ipfs")) return "ipfs_error";
  if (msg.includes("llm")) return "llm_error";
  if (msg.includes("missing ") || msg.includes("invalid ")) return "validation_error";
  return "execution_error";
}

function buildNoCommitDiagnostic(params: {
  nodeAddress: string;
  nodeId: string;
  taskId: string;
  round: number;
  taskType: string;
  templateId: number;
  reasonCode: number;
  payloadJson: any;
  errMsg: string;
  elapsedMs: number;
}): string {
  const {
    nodeAddress,
    nodeId,
    taskId,
    round,
    taskType,
    templateId,
    reasonCode,
    payloadJson,
    errMsg,
    elapsedMs,
  } = params;

  const diagnostic = {
    schema: "oracle_no_commit_diag_v1",
    node_address: nodeAddress,
    node_id: nodeId,
    task_id: taskId,
    round,
    task_type: taskType,
    template_id: templateId,
    stage: inferDiagnosticStage(taskType, errMsg),
    error_class: inferErrorClass(errMsg),
    reason_code: reasonCode,
    error_message: truncateForDiagnostic(errMsg, 320),
    target: pickTaskTarget(payloadJson),
    elapsed_ms: Math.max(0, Math.floor(elapsedMs)),
    emitted_at: new Date().toISOString(),
  };

  return JSON.stringify(diagnostic);
}

function meanFloor(values: number[]): number {
  if (!values.length) return 0;
  return Math.floor(values.reduce((a, b) => a + b, 0) / values.length);
}

function varianceSpread(values: number[]): number {
  if (!values.length) return 0;
  return Math.max(...values) - Math.min(...values);
}

async function tryLoadPreviousStorageResult(
  ctx: NodeContext,
  taskId: string,
  bundle: Awaited<ReturnType<typeof loadTaskBundle>>,
): Promise<string | null> {
  try {
    return (await loadLatestTaskResult(ctx.client, bundle))?.result ?? null;
  } catch (e: any) {
    console.warn(`[node ${ctx.nodeId}] previous STORAGE result unavailable task=${taskId}: ${String(e?.message ?? e)}`);
    return null;
  }
}

export async function runConsensusRound(
  ctx: NodeContext,
  params: {
    taskId: string;
    round: number;
    runStartedAtMs: number;
    normalized: string;
    assignedNodes: string[];
    quorumK: number;
    mediationMode: number;
    varianceMax: number;
    numericValueU64: number | null;
  },
): Promise<boolean> {
  const { client, identity, nodeId, myAddr } = ctx;
  const {
    taskId,
    round,
    runStartedAtMs,
    normalized,
    assignedNodes,
    quorumK,
    mediationMode,
    varianceMax,
    numericValueU64,
  } = params;

  const waitMs = optInt("ROUND_WAIT_MS", 45_000);
  const pollMs = optInt("ROUND_POLL_MS", 1_200);
  const takeoverSlotMs = Math.max(
    0,
    optInt("ABORT_TAKEOVER_TIMEOUT_MS", optInt("FINALIZE_TAKEOVER_TIMEOUT_MS", 15_000)),
  );
  const resultBytes = new TextEncoder().encode(normalized);
  const resultHashHex = sha256Hex(resultBytes);
  const leaders = await finalizeOrderByNodeId(client, assignedNodes);
  const leaderAddr = leaders[0] ?? "";

  const tx2 = await publishCommit({ client, keypair: identity.keypair, taskId, round, resultHashHex });
  console.log(`[node ${nodeId}] commit published tx=${tx2}`);

  const commits = await waitForCommitQuorum({ client, taskId, round, assignedNodes, quorumK, waitMs, pollMs, minTimestampMs: runStartedAtMs });
  if (!commits.ok) {
    if (await waitForOrderedActionTurn({
      client,
      taskId,
      nodeId,
      myAddr,
      order: leaders,
      action: "abort-commit",
      slotMs: takeoverSlotMs,
    })) {
      const reasonCode = commits.reason === "no_quorum" ? 1004 : 1002;
      const signerAddrs = leaders.slice(0, quorumK);
      const multisigAddr = await deriveAssignedCommitteeMultisigAddress(
        client,
        assignedNodes,
        quorumK,
        `assigned.abort-commit task=${taskId} round=${round}`,
      );
      const cert = buildCertificateBlob({ kind: "abort", signers: [myAddr], reasonCode, round });
      const digest = await abortTaskWithCertificate({
        client,
        keypair: identity.keypair,
        taskId,
        reasonCode,
        multisigBytes: cert,
        multisigAddr,
        signerAddrs,
        certificateBlob: cert,
      }).catch(() => null);

      if (digest) {
        if (commits.reason === "no_quorum") {
          console.log(
            `[node ${nodeId}] abort commit no quorum tx=${digest} no_commit=${commits.noCommitCount ?? "-"} max_possible_commits=${commits.maxPossibleCommits ?? "-"}/${quorumK}`,
          );
        } else {
          console.log(`[node ${nodeId}] abort commit timeout tx=${digest}`);
        }
      }
    }
    return false;
  }

  const tx3 = await publishReveal({
    client,
    keypair: identity.keypair,
    taskId,
    round,
    normalizedBytes: resultBytes,
    resultHashHex,
    numericValueU64,
  });
  console.log(`[node ${nodeId}] reveal published tx=${tx3}`);

  const reveal = await waitForRevealResolution({
    client,
    taskId,
    round,
    assignedNodes,
    quorumK,
    waitMs,
    pollMs,
    minTimestampMs: runStartedAtMs,
    extraCollectMs: optInt("REVEAL_EXTRA_COLLECT_MS", 2_500),
  });
  if (!reveal.ok) {
    console.log(`[node ${nodeId}] no winning reveal: ${reveal.reason}`);
    let mediationStarted = false;

    if (reveal.reason === "no_quorum" && mediationMode === 1 && reveal.reveals) {
      const numericValues = [...reveal.reveals.values()]
        .filter((m) => Number(m.value1 ?? 0) === 1)
        .map((m) => Number(m.value0 ?? 0))
        .filter((n) => Number.isFinite(n));

      if (numericValues.length >= quorumK) {
        const mean = meanFloor(numericValues);
        const variance = varianceSpread(numericValues);
        const canStartMediation = await waitForOrderedActionTurn({
          client,
          taskId,
          nodeId,
          myAddr,
          order: leaders,
          action: "start-mediation",
          slotMs: takeoverSlotMs,
        });
        const md = canStartMediation
          ? await startMediation({
              client,
              keypair: identity.keypair,
              taskId,
              observedVariance: variance,
            }).catch(() => null)
          : null;

        if (md) {
          mediationStarted = true;
          console.log(`[node ${nodeId}] mediation started tx=${md} mean=${mean} variance=${variance}`);
          return false;
        }
      }
    }

    if (!mediationStarted && reveal.reason === "no_quorum" && mediationMode === 1) {
      const latest = await loadTaskBundle(client, taskId).catch(() => null);
      const latestExecutionState = Number(latest?.taskFields?.execution_state ?? -1);
      if (latestExecutionState === 2) {
        console.log(`[node ${nodeId}] skip abort-reveal task=${taskId} reason=mediation_already_started`);
        return false;
      }
    }

    if (!mediationStarted && await waitForOrderedActionTurn({
      client,
      taskId,
      nodeId,
      myAddr,
      order: leaders,
      action: "abort-reveal",
      slotMs: takeoverSlotMs,
    })) {
      const reasonCode = reveal.reason === "reveal_timeout" ? 1002 : 1003;
      const signerAddrs = leaders.slice(0, quorumK);
      const multisigAddr = await deriveAssignedCommitteeMultisigAddress(
        client,
        assignedNodes,
        quorumK,
        `assigned.abort-reveal task=${taskId} round=${round}`,
      );
      const cert = buildCertificateBlob({ kind: "abort", signers: [myAddr], reasonCode, round });
      const digest = await abortTaskWithCertificate({
        client,
        keypair: identity.keypair,
        taskId,
        reasonCode,
        multisigBytes: cert,
        multisigAddr,
        signerAddrs,
        certificateBlob: cert,
      }).catch(() => null);

      if (digest) {
        if (reveal.reason === "reveal_timeout") {
          console.log(`[node ${nodeId}] abort reveal timeout tx=${digest}`);
        } else if (mediationMode === 1) {
          console.log(`[node ${nodeId}] abort mediation unavailable tx=${digest}`);
        } else {
          console.log(`[node ${nodeId}] abort no quorum tx=${digest}`);
        }
      }
    }
    return false;
  }

  console.log(
    `[node ${nodeId}] winning hash=${reveal.resultHashHex} approvals=${reveal.supporters.length}/${assignedNodes.length}`,
  );
  if (resultHashHex !== reveal.resultHashHex) return false;

  const tx4 = await publishPartialSignature({ client, keypair: identity.keypair, taskId, round, resultHashHex });
  console.log(`[node ${nodeId}] partial signature published tx=${tx4}`);

  const msgDigestHex = Buffer.from(consensusMessage(taskId, round, resultHashHex))
    .toString("hex")
    .toLowerCase();

  const partials = await waitForPartialQuorum({
    client,
    taskId,
    round,
    signerAddrs: reveal.supporters,
    quorumK,
    messageDigestHex: msgDigestHex,
    waitMs,
    pollMs,
    minTimestampMs: runStartedAtMs,
    extraCollectMs: optInt("PARTIAL_EXTRA_COLLECT_MS", 2_500),
  });

  if (!partials.ok) {
    if (await waitForOrderedActionTurn({
      client,
      taskId,
      nodeId,
      myAddr,
      order: leaders,
      action: "abort-partial",
      slotMs: takeoverSlotMs,
    })) {
      const signerAddrs = leaders.slice(0, quorumK);
      const multisigAddr = await deriveAssignedCommitteeMultisigAddress(
        client,
        assignedNodes,
        quorumK,
        `assigned.abort-partial task=${taskId} round=${round}`,
      );
      const cert = buildCertificateBlob({ kind: "abort", signers: [myAddr], reasonCode: 1005, round });
      const digest = await abortTaskWithCertificate({
        client,
        keypair: identity.keypair,
        taskId,
        reasonCode: 1005,
        multisigBytes: cert,
        multisigAddr,
        signerAddrs,
        certificateBlob: cert,
      }).catch(() => null);

      if (digest) console.log(`[node ${nodeId}] abort partial timeout tx=${digest}`);
    }
    return false;
  }

  const chosenSigners = [...partials.partials.keys()].sort();
  const finalizeIndex = leaders.indexOf(myAddr);
  if (finalizeIndex < 0) {
    console.warn(`[node ${nodeId}] skip finalize task=${taskId} reason=not_in_finalize_order me=${myAddr}`);
    return false;
  }

  const finalizeTakeoverSlotMs = Math.max(0, optInt("FINALIZE_TAKEOVER_TIMEOUT_MS", 15_000));
  const finalizeDelayMs = finalizeIndex * finalizeTakeoverSlotMs;
  if (finalizeDelayMs > 0) {
    console.log(
      `[node ${nodeId}] finalize backup slot task=${taskId} index=${finalizeIndex} delay_ms=${finalizeDelayMs} leader=${leaderAddr}`,
    );
    await sleep(finalizeDelayMs);

    const latest = await loadTaskBundle(client, taskId);
    const latestExecutionState = Number(latest.taskFields.execution_state ?? -1);
    if (!isLiveExecutionState(latestExecutionState)) {
      console.log(
        `[node ${nodeId}] skip backup finalize task=${taskId} reason=already_closed execution_state=${latestExecutionState}`,
      );
      return true;
    }
  }

  // La committee multisig del task e' definita dall'intero assigned set + quorum_k.
  // I chosen signers servono per aggregare abbastanza firme da soddisfare la soglia.
  const pubkeysByAddrB64 = await loadPubkeysByAddrB64(client);
  const assignedSorted = assignedNodes.map((a) => a.toLowerCase()).sort();
  const chosenSorted = chosenSigners.map((a) => a.toLowerCase()).sort();

  const pubsSorted: Array<{ nodeId: string; pubKeyBase64: string }> = [];
  for (const addr of assignedSorted) {
    const pk = pubkeysByAddrB64.get(addr);
    if (!pk) throw new Error(`Missing pubkey for ${addr}`);
    pubsSorted.push({ nodeId: addr, pubKeyBase64: pk });
  }

  const multiPk = buildMultiSigPublicKey(quorumK, pubsSorted);
  const multisigAddr = multiPk.toIotaAddress();
  assertCommitteeMultisigAddress({
    threshold: quorumK,
    pubs: pubsSorted,
    multisigAddr,
    context: `assigned.finalize task=${taskId} round=${round}`,
  });
  const chosenPartialSigsB64 = chosenSorted.map((addr) => {
    const partial = partials.partials.get(addr);
    if (!partial) throw new Error(`Missing partial signature for ${addr}`);
    return Buffer.from(partial.payload).toString("base64");
  });
  const combinedSigB64 = multiPk.combinePartialSignatures(chosenPartialSigsB64);
  const combinedSigBytes = Uint8Array.from(Buffer.from(combinedSigB64, "base64"));
  const verified = await multiPk.verifyPersonalMessage(
    consensusMessage(taskId, round, resultHashHex),
    combinedSigB64,
  );
  if (!verified) throw new Error("Combined multisig signature verification failed");

  console.log(
    `[node ${nodeId}] finalize signer set=${chosenSigners.length}/${assignedNodes.length} threshold=${quorumK} signers=${chosenSigners.join(",")}`,
  );

  const cert = buildCertificateBlob({
    kind: "finalize",
    signers: chosenSigners,
    resultHashHex,
    round,
  });

  const details = new TextEncoder().encode(
    JSON.stringify({
      mode: 1,
      hash: resultHashHex,
      signers: chosenSigners,
      round,
      multisigAddr,
    }),
  );

  await publishLeaderIntent({
    client,
    keypair: identity.keypair,
    taskId,
    round,
    finalizeMode: 1,
    details,
  }).catch((error) => {
    console.warn(
      `[node ${nodeId}] leader intent publish failed (ignored): ${String((error as any)?.message ?? error)}`,
    );
    return null;
  });

  const digest = await finalizeTaskWithCertificate({
    client,
    keypair: identity.keypair,
    taskId,
    resultBytes,
    multisigBytes: combinedSigBytes,
    multisigAddr,
    signerAddrs: chosenSigners,
    certificateBlob: cert,
    finalizeMode: round > 0 ? 2 : 1,
  }).catch((error) => {
    console.warn(
      `[node ${nodeId}] finalize_task_with_certificate failed: ${String((error as any)?.message ?? error)}`,
    );
    return null;
  });

  if (digest) console.log(`[node ${nodeId}] finalize tx=${digest}`);
  if (digest) return true;

  const latest = await loadTaskBundle(client, taskId).catch(() => null);
  const latestExecutionState = Number(latest?.taskFields?.execution_state ?? -1);
  if (!isLiveExecutionState(latestExecutionState)) {
    console.log(
      `[node ${nodeId}] finalize already handled by another node task=${taskId} execution_state=${latestExecutionState}`,
    );
    return true;
  }

  return false;
}

async function maybeAbortCommitNoQuorum(opts: {
  ctx: NodeContext;
  taskId: string;
  round: number;
  assignedNodes: string[];
  quorumK: number;
}) {
  const { ctx, taskId, round, assignedNodes, quorumK } = opts;
  const { client, identity, nodeId, myAddr } = ctx;
  const leaders = await finalizeOrderByNodeId(client, assignedNodes);

  const waitMs = optInt("ROUND_WAIT_MS", 45_000);
  const pollMs = optInt("ROUND_POLL_MS", 1_200);
  const runStartedAtMs = Number((await loadTaskBundle(client, taskId)).taskFields?.last_run_ms ?? 0) || 0;
  const commits = await waitForCommitQuorum({ client, taskId, round, assignedNodes, quorumK, waitMs, pollMs, minTimestampMs: runStartedAtMs });
  if (commits.ok) return;
  const takeoverSlotMs = Math.max(
    0,
    optInt("ABORT_TAKEOVER_TIMEOUT_MS", optInt("FINALIZE_TAKEOVER_TIMEOUT_MS", 15_000)),
  );
  if (!await waitForOrderedActionTurn({
    client,
    taskId,
    nodeId,
    myAddr,
    order: leaders,
    action: "abort-commit",
    slotMs: takeoverSlotMs,
  })) {
    return;
  }

  const reasonCode = commits.reason === "no_quorum" ? 1004 : 1002;
  const signerAddrs = leaders.slice(0, quorumK);
  const multisigAddr = await deriveAssignedCommitteeMultisigAddress(
    client,
    assignedNodes,
    quorumK,
    `assigned.abort-commit task=${taskId} round=${round}`,
  );
  const cert = buildCertificateBlob({ kind: "abort", signers: [myAddr], reasonCode, round });
  const digest = await abortTaskWithCertificate({
    client,
    keypair: identity.keypair,
    taskId,
    reasonCode,
    multisigBytes: cert,
    multisigAddr,
    signerAddrs,
    certificateBlob: cert,
  }).catch(() => null);

  if (!digest) return;

  if (commits.reason === "no_quorum") {
    console.log(
      `[node ${nodeId}] abort commit no quorum tx=${digest} no_commit=${commits.noCommitCount ?? "-"} max_possible_commits=${commits.maxPossibleCommits ?? "-"}/${quorumK}`,
    );
  } else {
    console.log(`[node ${nodeId}] abort commit timeout tx=${digest}`);
  }
}

export async function processAssigned(
  ctx: NodeContext,
  taskId: string,
  creator: string,
  opts?: { ignoreFreshness?: boolean; runIndex?: number },
): Promise<void> {
  const { client, identity, nodeId, myAddr, cache, stats } = ctx;

  const bundle = await loadTaskBundle(client, taskId);
  const { taskFields, configFields, runtimeFields } = bundle;
  if (!opts?.ignoreFreshness && !isTaskFreshForNode(bundle, ctx.startupMs)) {
    const createdAt = taskCreatedAtMs(bundle);
    console.log(`[node ${nodeId}] ignore stale task=${taskId} created_at_ms=${createdAt} startup_ms=${ctx.startupMs}`);
    return;
  }

  const round = Number(taskFields.active_round ?? 0) || 0;
  const chainRunIndex = Number(taskFields.active_run_index ?? 0) || 0;
  const eventRunIndex = opts?.runIndex != null ? Number(opts.runIndex ?? 0) || 0 : undefined;
  if (eventRunIndex != null && eventRunIndex !== chainRunIndex) {
    console.log(
      `[node ${nodeId}] ignore assignment task=${taskId} run=${eventRunIndex} reason=stale_event current_run=${chainRunIndex} round=${round}`,
    );
    return;
  }

  const activeRunIndex = eventRunIndex ?? chainRunIndex;
  const roundKey = `${taskId}:${activeRunIndex}:${round}:assigned:v3`;
  if (!cache.markRoundSeen(roundKey)) {
    console.log(`[node ${nodeId}] ignore duplicate assignment task=${taskId} run=${activeRunIndex} round=${round}`);
    return;
  }

  const status = Number(taskFields.status ?? -1);
  const executionState = Number(taskFields.execution_state ?? -1);
  const statusAllowsLiveExecution = status === 1 || status === 10;
  if (!statusAllowsLiveExecution || executionState !== 1) {
    console.log(
      `[node ${nodeId}] ignore task=${taskId} round=${round} reason=state_mismatch status=${status} execution_state=${executionState}`,
    );
    return;
  }

  const assignedNodes: string[] = moveToArray(taskFields.assigned_nodes)
    .map((x: any) => moveToString(x).toLowerCase())
    .filter(Boolean);
  if (!assignedNodes.includes(myAddr)) {
    console.log(
      `[node ${nodeId}] ignore task=${taskId} round=${round} reason=not_assigned assigned_nodes=${assignedNodes.join(",") || "<none>"} me=${myAddr}`,
    );
    return;
  }

  const taskType = bytesToUtf8(decodeVecU8(taskFields.task_type));
  const payloadStr = bytesToUtf8(decodeVecU8(taskFields.payload));
  const templateId = Number(taskFields.template_id ?? 0);
  const retentionDays = Number(configFields.retention_days ?? 0);
  const paymentIota = String(taskFields.payment_iota ?? "0");
  const mediationMode = Number(configFields.mediation_mode ?? 0);
  const varianceMax = Number(configFields.variance_max ?? 0);
  const myNode = await readRegisteredOracleNodeByAddr(client, myAddr);
  const acceptedTemplateIds = myNode?.acceptedTemplateIds ?? [];
  if (myNode) {
    ctx.acceptedTemplateIds = acceptedTemplateIds;
    savePersistedAcceptedTemplateIds(nodeId, acceptedTemplateIds);
  }

  if (!acceptsTemplate(templateId, acceptedTemplateIds)) {
    console.log(
      `[node ${nodeId}] ignore task=${taskId} round=${round} reason=template_not_accepted template=${templateId} accepted=${acceptedTemplateIds.join(",") || "<none>"}`,
    );
    return;
  }

  console.log(
    `[node ${nodeId}] assigned task id=${taskId} by=${creator || '-'} run=${activeRunIndex} round=${round} status=${status} execution_state=${executionState} type=${taskType} template=${templateId} retention_days=${retentionDays} payment_iota=${paymentIota}`,
  );

  let payloadJson: any;
  try {
    payloadJson = payloadStr ? JSON.parse(payloadStr) : {};
  } catch {
    payloadJson = { raw: payloadStr };
  }

  let normalized = "";
  const executionStartedAt = Date.now();
  try {
    const previousResult =
      taskType === "STORAGE" && Number(taskFields.latest_result_seq ?? 0) > 0
        ? await tryLoadPreviousStorageResult(ctx, taskId, bundle)
        : null;
    normalized = await executeTask({
      taskType,
      payload: payloadJson,
      taskId,
      nodeId,
      templateId,
      declaredDownloadBytes: Number(configFields.declared_download_bytes ?? 0) || undefined,
      retentionDays,
      taskCreatedAtMs: Number(runtimeFields.created_at_ms ?? 0) || taskCreatedAtMs(bundle),
      previousResult,
    });
    console.log(`\n[node ${nodeId}] normalized output (first 2000 chars):\n${normalized.slice(0, 2000)}\n`);
  } catch (e: any) {
    const errMsg = String(e?.message ?? e);
    const diagnosticPayload = buildNoCommitDiagnostic({
      nodeAddress: identity.address,
      nodeId,
      taskId,
      round,
      taskType,
      templateId,
      reasonCode: 1,
      payloadJson,
      errMsg,
      elapsedMs: Date.now() - executionStartedAt,
    });
    console.error(`[node ${nodeId}] task execution failed: ${errMsg}`);
    console.error(`[node ${nodeId}] no_commit diagnostic payload: ${diagnosticPayload}`);
    stats.recordTaskCompleted({
      outcome: "not_ok",
      taskId,
      round,
      taskType,
      error: errMsg,
    });
    try {
      const tx = await publishNoCommit({
        client,
        keypair: identity.keypair,
        taskId,
        round,
        reasonCode: 1,
        message: diagnosticPayload,
      });
      console.log(`[node ${nodeId}] no_commit published tx=${tx}`);
      await maybeAbortCommitNoQuorum({
        ctx,
        taskId,
        round,
        assignedNodes,
        quorumK: Number(taskFields.quorum_k ?? assignedNodes.length) || assignedNodes.length,
      });
    } catch (txErr: any) {
      console.error(`[node ${nodeId}] no_commit publish failed: ${String(txErr?.message ?? txErr)}`);
    }
    return;
  }

  const numericExtract = extractNumericValue(normalized, payloadJson);
  const numericScale = extractNumericScale(payloadJson);
  const numericValueU64 = numericExtract.value != null ? toConsensusU64(numericExtract.value, numericScale) : null;
  console.log(
    `[node ${nodeId}] numeric extract source=${numericExtract.source} path=${numericExtract.path ?? "-"} raw=${numericExtract.value ?? "-"} scale=${numericScale} u64=${numericValueU64 ?? "-"}`,
  );

  const ok = await runConsensusRound(ctx, {
    taskId,
    round,
    runStartedAtMs: Number(taskFields.last_run_ms ?? runtimeFields.last_run_ms ?? 0) || Date.now(),
    normalized,
    assignedNodes,
    quorumK: Number(taskFields.quorum_k ?? assignedNodes.length) || assignedNodes.length,
    mediationMode,
    varianceMax,
    numericValueU64,
  });

  stats.recordTaskCompleted({
    outcome: ok ? "ok" : "not_ok",
    taskId,
    round,
    taskType,
    error: ok ? null : "Consensus/finalization did not complete successfully",
  });
}

export async function replayRecentAssignments(ctx: NodeContext, limit = 50): Promise<void> {
  const { client, taskAssignedType, nodeId } = ctx;
  try {
    const page: any = await client.queryEvents({
      query: { MoveEventType: taskAssignedType },
      cursor: null,
      limit,
      order: "descending",
    } as any);

    const items = Array.isArray(page?.data) ? [...page.data].reverse() : [];
    for (const ev of items) {
      const pj: any = ev?.parsedJson ?? {};
      const taskId = String(pj.task_id ?? "");
      const creator = String(pj.actor ?? "");
      const runIndex = pj.run_index != null ? Number(pj.run_index ?? 0) : undefined;
      if (!taskId) continue;
      await processAssigned(ctx, taskId, creator, { ignoreFreshness: true, runIndex });
    }
  } catch (e: any) {
    console.warn(`[node ${nodeId}] replay recent assignments failed (continue): ${e?.message ?? e}`);
  }
}
