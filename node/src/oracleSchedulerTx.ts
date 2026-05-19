// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Transaction } from "@iota/iota-sdk/transactions";

import { bcsU64 } from "./bcs";
import {
  getClockId,
  getIotaSystemStateId,
  getRandomId,
  getStateId,
  getSystemPackageId,
  getTaskRegistryId,
  getTaskSchedulerQueueId,
  getTasksPackageId,
  getTreasuryId,
} from "./config/env";
import type { NodeContext } from "./nodeContext";
import { resolveNodeRegistryId } from "./services/nodeRegistry";
import { signAndExecuteWithLockRetry } from "./txRetry";

function gasBudget(envKey: string, def: number): number {
  const raw = process.env[envKey]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.floor(n);
}

function tasksPkg(): string {
  return getTasksPackageId();
}

export async function pruneOracleNodesByValidatorCommitteeTx(ctx: NodeContext): Promise<string> {
  const stateId = getStateId();
  const nodeRegistryId = await resolveNodeRegistryId(ctx.client, stateId);
  const res = await signAndExecuteWithLockRetry({
    client: ctx.client,
    signer: ctx.identity.keypair,
    transactionFactory: () => {
      const tx = new Transaction();
      tx.setGasBudget(gasBudget("GAS_BUDGET_ORACLE_NODE_PRUNE", gasBudget("GAS_BUDGET", 20_000_000)));
      tx.moveCall({
        target: `${getSystemPackageId()}::systemState::prune_oracle_nodes_if_epoch_changed`,
        arguments: [tx.object(nodeRegistryId), tx.object(stateId), tx.object(getIotaSystemStateId())],
      });
      return tx;
    },
    options: { showEffects: true, showObjectChanges: true },
    label: "prune_oracle_nodes_if_epoch_changed",
  });
  return String(res.digest);
}

export async function reconcileSchedulerQueueTx(ctx: NodeContext): Promise<string> {
  const nodeRegistryId = await resolveNodeRegistryId(ctx.client, getStateId());
  const res = await signAndExecuteWithLockRetry({
    client: ctx.client,
    signer: ctx.identity.keypair,
    transactionFactory: () => {
      const tx = new Transaction();
      tx.setGasBudget(gasBudget("GAS_BUDGET_SCHEDULER_RECONCILE", gasBudget("GAS_BUDGET", 20_000_000)));
      tx.moveCall({
        target: `${tasksPkg()}::oracle_tasks::reconcile_scheduler_queue`,
        arguments: [tx.object(getTaskSchedulerQueueId()), tx.object(nodeRegistryId)],
      });
      return tx;
    },
    options: { showEffects: true },
    label: "scheduler_reconcile_queue",
  });
  return String(res.digest);
}

export async function startSchedulerRoundTx(ctx: NodeContext): Promise<string> {
  const nodeRegistryId = await resolveNodeRegistryId(ctx.client, getStateId());
  const res = await signAndExecuteWithLockRetry({
    client: ctx.client,
    signer: ctx.identity.keypair,
    transactionFactory: () => {
      const tx = new Transaction();
      tx.setGasBudget(gasBudget("GAS_BUDGET_SCHEDULER_START", gasBudget("GAS_BUDGET", 20_000_000)));
      tx.moveCall({
        target: `${tasksPkg()}::oracle_tasks::start_scheduler_round`,
        arguments: [tx.object(getTaskSchedulerQueueId()), tx.object(nodeRegistryId), tx.object(getClockId())],
      });
      return tx;
    },
    options: { showEffects: true },
    label: "scheduler_start_round",
  });
  return String(res.digest);
}

export async function advanceSchedulerQueueTx(ctx: NodeContext): Promise<string> {
  const nodeRegistryId = await resolveNodeRegistryId(ctx.client, getStateId());
  const res = await signAndExecuteWithLockRetry({
    client: ctx.client,
    signer: ctx.identity.keypair,
    transactionFactory: () => {
      const tx = new Transaction();
      tx.setGasBudget(gasBudget("GAS_BUDGET_SCHEDULER_ADVANCE", gasBudget("GAS_BUDGET", 20_000_000)));
      tx.moveCall({
        target: `${tasksPkg()}::oracle_tasks::advance_scheduler_queue`,
        arguments: [tx.object(getTaskSchedulerQueueId()), tx.object(nodeRegistryId), tx.object(getClockId())],
      });
      return tx;
    },
    options: { showEffects: true },
    label: "scheduler_advance_queue",
  });
  return String(res.digest);
}

export async function completeSchedulerRoundTx(ctx: NodeContext, processedTasks: number): Promise<string> {
  const nodeRegistryId = await resolveNodeRegistryId(ctx.client, getStateId());
  const res = await signAndExecuteWithLockRetry({
    client: ctx.client,
    signer: ctx.identity.keypair,
    transactionFactory: () => {
      const tx = new Transaction();
      tx.setGasBudget(gasBudget("GAS_BUDGET_SCHEDULER_COMPLETE", gasBudget("GAS_BUDGET", 20_000_000)));
      tx.moveCall({
        target: `${tasksPkg()}::oracle_tasks::complete_scheduler_round`,
        arguments: [
          tx.object(getTaskSchedulerQueueId()),
          tx.object(nodeRegistryId),
          tx.object(getClockId()),
          tx.pure(bcsU64(processedTasks)),
        ],
      });
      return tx;
    },
    options: { showEffects: true },
    label: "scheduler_complete_round",
  });
  return String(res.digest);
}

export async function submitTaskRunTx(ctx: NodeContext, taskId: string): Promise<string> {
  const stateId = getStateId();
  const nodeRegistryId = await resolveNodeRegistryId(ctx.client, stateId);
  const res = await signAndExecuteWithLockRetry({
    client: ctx.client,
    signer: ctx.identity.keypair,
    transactionFactory: () => {
      const tx = new Transaction();
      tx.setGasBudget(gasBudget("GAS_BUDGET_SCHEDULED_TASK_SUBMIT", gasBudget("GAS_BUDGET", 35_000_000)));
      tx.moveCall({
        target: `${tasksPkg()}::oracle_tasks::submit_task_run`,
        arguments: [
          tx.object(getTaskRegistryId()),
          tx.object(getTaskSchedulerQueueId()),
          tx.object(taskId),
          tx.object(stateId),
          tx.object(nodeRegistryId),
          tx.object(getTreasuryId()),
          tx.object(getRandomId()),
          tx.object(getClockId()),
        ],
      });
      return tx;
    },
    options: { showEffects: true },
    label: "scheduler_submit_task",
  });
  return String(res.digest);
}
