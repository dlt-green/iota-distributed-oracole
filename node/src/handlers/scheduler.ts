// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { NodeContext } from "../nodeContext";
import { assertCommitteeMultisigAddress, buildMultiSigPublicKey } from "../multisig.js";
import {
  advanceSchedulerQueueTx,
  completeSchedulerRoundTx,
  pruneOracleNodesByValidatorCommitteeTx,
  reconcileSchedulerQueueTx,
  startSchedulerRoundTx,
  submitTaskRunTx,
} from "../oracleSchedulerTx";
import { optInt, supportsScheduler } from "../nodeConfig";
import { abortTaskWithCertificate } from "../oracleMessages";
import { buildCertificateBlob } from "../services/eventConsensus";
import { loadPubkeysByAddrB64 } from "../services/pubkeys";
import {
  listDueTasks,
  readRegisteredOracleNodeByAddr,
  readRegisteredOracleNodes,
  readTaskRegistry,
  readTaskSchedulerQueue,
} from "../services/schedulerReader";
import { loadTaskBundle } from "../services/taskObjects";
import { savePersistedAcceptedTemplateIds } from "../templateState";
import { moveToArray, moveToString } from "../utils/move";

function schedulerLeaseMs(): number {
  return optInt("SCHEDULER_ROUND_TIMEOUT_MS", 30_000);
}

function staleRunTimeoutMs(): number {
  return optInt("RUN_WATCHDOG_TIMEOUT_MS", optInt("ROUND_WAIT_MS", 45_000) + 5_000);
}

function queueIndexOf(nodeIds: number[], nodeId: number): number {
  return nodeIds.findIndex((item) => item === nodeId);
}

function schedulerNodesOnly<T extends { acceptedTemplateIds: number[] }>(nodes: T[]): T[] {
  return nodes.filter((node) => supportsScheduler(node.acceptedTemplateIds));
}

function queueNeedsReconcile(queueNodeIds: number[], registeredNodeIds: number[], myNodeId: number): boolean {
  if (!queueNodeIds.length) return true;
  if (!queueNodeIds.includes(myNodeId)) return true;

  const registered = new Set(registeredNodeIds);
  if (queueNodeIds.some((nodeId) => !registered.has(nodeId))) return true;
  if (registeredNodeIds.some((nodeId) => !queueNodeIds.includes(nodeId))) return true;

  return false;
}

function leaderOrder(assigned: string[]): string[] {
  return [...assigned].map((x) => x.toLowerCase()).sort();
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

async function abortStaleOpenRuns(ctx: NodeContext, nowMs: number): Promise<number> {
  const taskIds = await readTaskRegistry(ctx.client);
  let aborted = 0;

  for (const taskId of taskIds) {
    try {
      const bundle = await loadTaskBundle(ctx.client, taskId);
      const fields = bundle.taskFields ?? {};
      const status = Number(fields.status ?? 0);
      const executionState = Number(fields.execution_state ?? 0);
      const latestResultSeq = Number(fields.latest_result_seq ?? 0);
      const activeRunIndex = Number(fields.active_run_index ?? 0);
      const lastRunMs = Number(fields.last_run_ms ?? 0);
      const quorumK = Math.max(1, Number(fields.quorum_k ?? 1));
      const assignedNodes = moveToArray(fields.assigned_nodes)
        .map(moveToString)
        .map((addr) => addr.toLowerCase())
        .filter(Boolean);

      if (status !== 1) continue;
      if (executionState !== 1) continue;
      if (activeRunIndex <= latestResultSeq) continue;
      if (lastRunMs <= 0 || nowMs < lastRunMs + staleRunTimeoutMs()) continue;
      if (!assignedNodes.length) continue;

      const leaders = leaderOrder(assignedNodes);
      if (leaders[0] !== ctx.myAddr.toLowerCase()) continue;

      const signerAddrs = leaders.slice(0, Math.min(quorumK, leaders.length));
      const multisigAddr = await deriveAssignedCommitteeMultisigAddress(
        ctx.client,
        assignedNodes,
        quorumK,
        `scheduler.abort-stale task=${taskId} round=${Math.max(0, Number(fields.active_round ?? 0))}`,
      );
      const cert = buildCertificateBlob({
        kind: "abort",
        signers: [ctx.myAddr.toLowerCase()],
        reasonCode: 1002,
        round: Math.max(0, Number(fields.active_round ?? 0)),
      });

      const digest = await abortTaskWithCertificate({
        client: ctx.client,
        keypair: ctx.identity.keypair,
        taskId,
        reasonCode: 1002,
        multisigBytes: cert,
        multisigAddr,
        signerAddrs,
        certificateBlob: cert,
      });
      aborted += 1;
      console.log(`[scheduler ${ctx.nodeId}] abort stale open run task=${taskId} tx=${digest}`);
    } catch (e: any) {
      console.warn(`[scheduler ${ctx.nodeId}] stale-run watchdog failed task=${taskId}: ${String(e?.message ?? e)}`);
    }
  }

  return aborted;
}

function takeoverEligible(
  activeRoundStartedMs: number,
  lastRoundCompletedMs: number,
  queueIndex: number,
  nowMs: number,
): boolean {
  if (queueIndex <= 0) return false;
  const baseMs = activeRoundStartedMs > 0 ? activeRoundStartedMs : lastRoundCompletedMs;
  if (baseMs <= 0) return false;
  return nowMs >= baseMs + queueIndex * schedulerLeaseMs();
}

export async function processSchedulerRound(ctx: NodeContext): Promise<void> {
  const nowMs = Date.now();
  let processed = 0;
  processed += await abortStaleOpenRuns(ctx, nowMs);

  const currentNode = await readRegisteredOracleNodeByAddr(ctx.client, ctx.myAddr);
  if (!currentNode) {
    console.log(`[scheduler ${ctx.nodeId}] skip round: node not registered on-chain`);
    return;
  }
  ctx.acceptedTemplateIds = currentNode.acceptedTemplateIds;
  savePersistedAcceptedTemplateIds(ctx.nodeId, currentNode.acceptedTemplateIds);
  if (!supportsScheduler(currentNode.acceptedTemplateIds)) {
    console.log(
      `[scheduler ${ctx.nodeId}] skip round: scheduler role not enabled on-chain accepted=${currentNode.acceptedTemplateIds.join(",") || "<none>"}`,
    );
    return;
  }

  const registeredNodes = schedulerNodesOnly(await readRegisteredOracleNodes(ctx.client));
  const myNode = registeredNodes.find((node) => node.addr === ctx.myAddr);
  if (!myNode) return;
  const registeredNodeIds = registeredNodes.map((node) => node.nodeId);

  let queue = await readTaskSchedulerQueue(ctx.client);
  if (queueNeedsReconcile(queue.nodeIds, registeredNodeIds, myNode.nodeId)) {
    try {
      const digest = await reconcileSchedulerQueueTx(ctx);
      console.log(
        `[scheduler ${ctx.nodeId}] reconcile queue tx=${digest} queue=[${queue.nodeIds.join(",") || "-"}] registered=[${registeredNodeIds.join(",") || "-"}]`,
      );
    } catch (e: any) {
      console.warn(`[scheduler ${ctx.nodeId}] reconcile queue failed: ${String(e?.message ?? e)}`);
      return;
    }
    queue = await readTaskSchedulerQueue(ctx.client);
  }

  if (!queue.nodeIds.length && !registeredNodeIds.length) {
    console.warn(`[scheduler ${ctx.nodeId}] queue empty`);
    return;
  }

  const refreshedIndex = queueIndexOf(queue.nodeIds, myNode.nodeId);
  if (refreshedIndex < 0) {
    console.warn(
      `[scheduler ${ctx.nodeId}] current node missing from queue after reconcile node_id=${myNode.nodeId} queue=[${queue.nodeIds.join(",") || "-"}]`,
    );
    return;
  }

  if (queue.headNodeId !== myNode.nodeId) {
    if (!takeoverEligible(queue.activeRoundStartedMs, queue.lastRoundCompletedMs, refreshedIndex, nowMs)) return;
    try {
      const digest = await advanceSchedulerQueueTx(ctx);
      console.log(`[scheduler ${ctx.nodeId}] advance queue tx=${digest}`);
    } catch (e: any) {
      console.warn(`[scheduler ${ctx.nodeId}] advance failed: ${String(e?.message ?? e)}`);
      return;
    }
    queue = await readTaskSchedulerQueue(ctx.client);
    if (queue.headNodeId !== myNode.nodeId) return;
  }

  try {
    const digest = await pruneOracleNodesByValidatorCommitteeTx(ctx);
    console.log(`[scheduler ${ctx.nodeId}] prune non-committee delegated nodes tx=${digest}`);
  } catch (e: any) {
    console.warn(`[scheduler ${ctx.nodeId}] prune non-committee delegated nodes failed: ${String(e?.message ?? e)}`);
    return;
  }

  const maxTasks = optInt("SCHEDULER_MAX_TASKS_PER_ROUND", 100);
  const dueTasks = (await listDueTasks(ctx.client, nowMs)).slice(0, maxTasks);
  console.log(`[scheduler ${ctx.nodeId}] due tasks=${dueTasks.length}`);
  if (dueTasks.length === 0) {
    try {
      const digest = await advanceSchedulerQueueTx(ctx);
      console.log(`[scheduler ${ctx.nodeId}] advance queue tx=${digest}`);
    } catch (e: any) {
      console.warn(`[scheduler ${ctx.nodeId}] idle advance failed: ${String(e?.message ?? e)}`);
    }
    return;
  }

  const startDigest = await startSchedulerRoundTx(ctx);
  console.log(`[scheduler ${ctx.nodeId}] start round tx=${startDigest}`);

  try {
    for (const task of dueTasks) {
      try {
        const digest = await submitTaskRunTx(ctx, task.id);
        processed += 1;
        console.log(`[scheduler ${ctx.nodeId}] submitted task run id=${task.id} tx=${digest}`);
      } catch (e: any) {
        console.warn(
          `[scheduler ${ctx.nodeId}] submit task run failed id=${task.id}: ${String(e?.message ?? e)}`,
        );
      }
    }
  } finally {
    try {
      const digest = await completeSchedulerRoundTx(ctx, processed);
      console.log(`[scheduler ${ctx.nodeId}] complete round tx=${digest} processed=${processed}`);
    } catch (e: any) {
      console.warn(`[scheduler ${ctx.nodeId}] complete round failed: ${String(e?.message ?? e)}`);
    }
  }
}
