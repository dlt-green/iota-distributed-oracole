// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { useEffect, useMemo, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@iota/dapp-kit";
import { IotaClient } from "@iota/iota-sdk/client";
import { fetchTaskSchedules, prepareScheduledTaskActionWallet } from "../lib/api";
import { getChainForOracleNetwork } from "../lib/iotaNetwork";
import type {
  OracleNetwork,
  ScheduledTaskActionRequest,
  TaskScheduleItem,
  TaskSchedulesResponse,
} from "../types";

type Props = {
  activeNetwork: OracleNetwork;
  tasksPackageId: string | null;
  systemPackageId: string | null;
  onSelectTask?: (taskId: string) => void;
};

type WalletTaskControls = {
  controllerCapId: string | null;
  ownedTaskIds: string[];
  ownerCapIdsByTaskId: Record<string, string>;
  loading: boolean;
  error: string | null;
};

const REFRESH_MS = 10000;
const MAINNET_RPC_URL = import.meta.env.VITE_IOTA_MAINNET_RPC_URL?.trim() || "https://api.mainnet.iota.cafe";
const TESTNET_RPC_URL = import.meta.env.VITE_IOTA_TESTNET_RPC_URL?.trim() || "https://api.testnet.iota.cafe";
const DEVNET_RPC_URL =
  import.meta.env.VITE_IOTA_DEVNET_RPC_URL?.trim() ||
  import.meta.env.VITE_IOTA_RPC_URL?.trim() ||
  "https://api.devnet.iota.cafe";

function shortAddress(address: string | null | undefined, start = 6, end = 4): string {
  const value = String(address ?? "").trim();
  if (!value) return "-";
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function normalizeAddress(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "";
  return text.startsWith("0x") ? text : `0x${text}`;
}

function formatMs(value: string | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return new Date(n).toLocaleString();
}

function formatIntervalMs(value: string | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "-";
  const seconds = Math.floor(n / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatIotaAtomic(value: string | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return value ? String(value) : "-";
  return (n / 1_000_000_000).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
}

function statusClass(item: TaskScheduleItem): string {
  const hasUpcomingRun = Number(item.nextRunMs || "0") > 0;
  if (item.status === 10 && hasUpcomingRun) return "is-on";
  const label = item.statusLabel.toLowerCase();
  if (label === "active") return "is-on";
  if (label === "completed" || label === "cancelled") return "is-off";
  return "is-warn";
}

function taskStatusLabel(status: number): string {
  switch (status) {
    case 1:
      return "ACTIVE";
    case 2:
      return "SUSPENDED";
    case 3:
      return "DEPLETED";
    case 9:
      return "CANCELLED";
    case 10:
      return "ENDED";
    case 11:
      return "COMPLETED";
    default:
      return String(status || "-");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function extractFields(value: unknown): Record<string, unknown> | null {
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

  const valueField = asRecord(record.value);
  if (valueField) {
    const nested = extractFields(valueField);
    if (nested) return nested;
  }

  return null;
}

function extractOwnedObjectId(entry: unknown): string {
  const record = asRecord(entry);
  if (!record) return "";
  const data = asRecord(record.data);
  return String(data?.objectId ?? record.objectId ?? "").trim();
}

function extractOwnerCapTaskId(entry: unknown): string {
  const record = asRecord(entry);
  const data = asRecord(record?.data) ?? record;
  const fields = extractFields(data) ?? data;
  const raw = fields?.task_id ?? fields?.taskId;
  if (typeof raw === "string") return normalizeAddress(raw);
  const nested = asRecord(raw);
  return normalizeAddress(String(nested?.id ?? nested?.objectId ?? nested?.value ?? ""));
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  const record = asRecord(value);
  if (!record) return "";
  for (const key of ["value", "id", "objectId", "bytes", "balance"]) {
    const nested = record[key];
    if (typeof nested === "string" || typeof nested === "number" || typeof nested === "bigint") {
      return String(nested);
    }
  }
  return "";
}

function balanceToString(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return String(value);
  const record = asRecord(value);
  if (!record) return "0";
  for (const key of ["value", "balance", "total"]) {
    if (record[key] != null) return balanceToString(record[key]);
  }
  return "0";
}

function hasTerminalScheduleStatus(item: TaskScheduleItem): boolean {
  const hasUpcomingRun = Number(item.nextRunMs || "0") > 0;
  if (item.status === 10) return !hasUpcomingRun;
  return item.status === 9 || item.status === 11;
}

function displayStatusLabel(item: TaskScheduleItem): string {
  const hasUpcomingRun = Number(item.nextRunMs || "0") > 0;
  if (item.status === 10 && hasUpcomingRun) return "SCHEDULED";
  return item.statusLabel;
}

function taskItemFromObject(taskId: string, object: any): TaskScheduleItem | null {
  const fields = extractFields(object?.data?.content) ?? extractFields(object?.data) ?? null;
  if (!fields) return null;
  const status = Number(toText(fields.status) || 0);
  return {
    id: normalizeAddress(taskId),
    creator: normalizeAddress(toText(fields.creator)),
    status,
    statusLabel: taskStatusLabel(status),
    templateId: toText(fields.template_id),
    runCount: toText(fields.latest_result_seq),
    nextRunMs: toText(fields.next_run_ms),
    lastRunMs: toText(fields.last_run_ms),
    startScheduleMs: toText(fields.start_schedule_ms),
    endScheduleMs: toText(fields.end_schedule_ms),
    intervalMs: toText(fields.interval_ms),
    balanceIota: balanceToString(fields.available_balance_iota),
    lastSchedulerNode: normalizeAddress(toText(fields.last_scheduler_node)) || null,
  };
}

async function fetchOwnedObjectsByFilter(
  client: IotaClient,
  owner: string,
  filter: Record<string, unknown>,
  showContent = false,
) {
  const out: unknown[] = [];
  let cursor: string | null | undefined = null;

  for (;;) {
    const page: any = await client.getOwnedObjects({
      owner,
      cursor,
      filter,
      options: {
        showType: true,
        showContent,
      },
    } as any);

    out.push(...(Array.isArray(page?.data) ? page.data : []));
    if (!page?.hasNextPage) break;
    cursor = page?.nextCursor;
  }

  return out;
}

export default function TaskSchedulesPage({
  activeNetwork,
  tasksPackageId,
  systemPackageId,
  onSelectTask,
}: Props) {
  const [data, setData] = useState<TaskSchedulesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [busyActionKey, setBusyActionKey] = useState<string | null>(null);
  const [ownedTaskItems, setOwnedTaskItems] = useState<TaskScheduleItem[]>([]);
  const [showOnlyMine, setShowOnlyMine] = useState(false);
  const [controls, setControls] = useState<WalletTaskControls>({
    controllerCapId: null,
    ownedTaskIds: [],
    ownerCapIdsByTaskId: {},
    loading: false,
    error: null,
  });
  const currentAccount = useCurrentAccount();
  const rpcClients = useMemo(
    () => ({
      mainnet: new IotaClient({ url: MAINNET_RPC_URL }),
      testnet: new IotaClient({ url: TESTNET_RPC_URL }),
      devnet: new IotaClient({ url: DEVNET_RPC_URL }),
    }),
    [],
  );
  const networkClient = rpcClients[activeNetwork];

  const { mutateAsync: signAndExecuteTransaction } = useSignAndExecuteTransaction({
    execute: async ({ bytes, signature }) =>
      await networkClient.executeTransactionBlock({
        transactionBlock: bytes,
        signature,
        options: {
          showRawEffects: true,
          showEffects: true,
          showObjectChanges: true,
          showEvents: true,
        },
      }),
  });

  useEffect(() => {
    let cancelled = false;

    const load = async (withLoading = false) => {
      if (withLoading) setLoading(true);
      try {
        const response = await fetchTaskSchedules(activeNetwork);
        if (!cancelled) {
          setData(response);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled && withLoading) setLoading(false);
      }
    };

    void load(true);
    const timer = window.setInterval(() => {
      void load(false);
    }, REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeNetwork, refreshNonce]);

  useEffect(() => {
    let cancelled = false;

    async function loadControls() {
        if (!currentAccount?.address || !tasksPackageId || !systemPackageId) {
          if (!cancelled) {
            setControls({
              controllerCapId: null,
              ownedTaskIds: [],
              ownerCapIdsByTaskId: {},
              loading: false,
              error: null,
            });
        }
        return;
      }

      setControls((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const controllerCapType = `${systemPackageId}::systemState::ControllerCap`;
        const ownerCapType = `${tasksPackageId}::oracle_tasks::TaskOwnerCap`;
        const owner = currentAccount.address;

        const [controllerCaps, ownerCaps] = await Promise.all([
          fetchOwnedObjectsByFilter(networkClient, owner, { StructType: controllerCapType }, false),
          fetchOwnedObjectsByFilter(networkClient, owner, { StructType: ownerCapType }, true),
        ]);

        if (cancelled) return;

        const ownerCapIdsByTaskId = ownerCaps.reduce<Record<string, string>>((acc, entry) => {
          const taskId = extractOwnerCapTaskId(entry);
          const ownerCapId = extractOwnedObjectId(entry);
          if (taskId && ownerCapId) acc[taskId] = ownerCapId;
          return acc;
        }, {});
        const ownedTaskIds = Object.keys(ownerCapIdsByTaskId);

        setControls({
          controllerCapId: extractOwnedObjectId(controllerCaps[0]) || null,
          ownedTaskIds,
          ownerCapIdsByTaskId,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (!cancelled) {
          setControls({
            controllerCapId: null,
            ownedTaskIds: [],
            ownerCapIdsByTaskId: {},
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    void loadControls();

    return () => {
      cancelled = true;
    };
  }, [activeNetwork, currentAccount?.address, networkClient, systemPackageId, tasksPackageId]);

  useEffect(() => {
    let cancelled = false;

    async function loadOwnedTasks() {
      if (!controls.ownedTaskIds.length) {
        if (!cancelled) setOwnedTaskItems([]);
        return;
      }

      try {
        const items = await Promise.all(
          controls.ownedTaskIds.map(async (taskId) => {
            try {
              const obj = await networkClient.getObject({
                id: taskId,
                options: { showContent: true, showType: true },
              } as any);
              return taskItemFromObject(taskId, obj);
            } catch {
              return null;
            }
          }),
        );

        if (!cancelled) {
          setOwnedTaskItems(items.filter((item): item is TaskScheduleItem => Boolean(item)));
        }
      } catch {
        if (!cancelled) setOwnedTaskItems([]);
      }
    }

    void loadOwnedTasks();

    return () => {
      cancelled = true;
    };
  }, [controls.ownedTaskIds, data, networkClient, refreshNonce]);

  const connectedAddress = normalizeAddress(currentAccount?.address);
  const hasControllerCap = Boolean(controls.controllerCapId);
  const sortedItems = useMemo(() => {
    const merged = new Map<string, TaskScheduleItem>();
    for (const item of data?.items ?? []) merged.set(normalizeAddress(item.id), item);
    for (const item of ownedTaskItems) {
      const key = normalizeAddress(item.id);
      if (!merged.has(key)) merged.set(key, item);
    }
    return Array.from(merged.values()).sort((a, b) => {
      const startDiff = Number(b.startScheduleMs || "0") - Number(a.startScheduleMs || "0");
      if (startDiff !== 0) return startDiff;
      const nextRunDiff = Number(b.nextRunMs || "0") - Number(a.nextRunMs || "0");
      if (nextRunDiff !== 0) return nextRunDiff;
      return a.id.localeCompare(b.id);
    });
  }, [data?.items, ownedTaskItems]);
  const items = useMemo(() => {
    if (!showOnlyMine || !connectedAddress) return sortedItems;
    return sortedItems.filter((item) => normalizeAddress(item.creator) === connectedAddress);
  }, [connectedAddress, showOnlyMine, sortedItems]);
  const canManageAnyTask = Boolean(
    currentAccount && (hasControllerCap || sortedItems.some((item) => normalizeAddress(item.creator) === connectedAddress)),
  );

  async function handleAction(
    item: TaskScheduleItem,
    baseAction: Omit<ScheduledTaskActionRequest, "taskId">,
    label: string,
  ) {
    if (!currentAccount?.address) {
      setError("Connect a wallet to manage scheduled tasks.");
      return;
    }

    const actionKey = `${item.id}:${baseAction.action}`;
    const action: ScheduledTaskActionRequest = {
      ...baseAction,
      taskId: item.id,
    };

    if (action.action === "fund" && !action.amountIota && !action.amountNanoIota) {
      const amountIota = window.prompt("Amount to add (IOTA)", "1");
      if (amountIota == null) return;
      if (!amountIota.trim()) {
        setError("Enter a funding amount greater than zero.");
        return;
      }
      action.amountIota = amountIota.trim().replace(/,/g, ".");
    }

    setBusyActionKey(actionKey);
    setActionNotice(null);
    setError(null);
    try {
      const prepared = await prepareScheduledTaskActionWallet(action, currentAccount.address, activeNetwork);
      const execution = await signAndExecuteTransaction({
        transaction: prepared.serializedTransaction,
        chain: getChainForOracleNetwork(activeNetwork),
      });

      const digest = String((execution as any)?.digest ?? "").trim();
      if (digest && typeof (networkClient as any)?.waitForTransaction === "function") {
        try {
          await (networkClient as any).waitForTransaction({
            digest,
            options: {
              showEffects: true,
              showObjectChanges: true,
              showEvents: true,
            },
          });
        } catch {
          // Best effort confirmation only.
        }
      }

      setActionNotice(`${label} submitted${digest ? ` (${digest})` : ""}.`);
      setRefreshNonce((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyActionKey(null);
    }
  }

  return (
    <>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {actionNotice ? <div className="alert alert-warn">{actionNotice}</div> : null}
      {controls.error ? <div className="alert alert-warn">{controls.error}</div> : null}
      {data?.warnings?.length ? (
        <div className="alert alert-warn">
          {data.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      ) : null}

      <section className="card card-spaced">
        <div className="section-title">Scheduler queue</div>
        {loading ? (
          <div className="empty">Loading scheduler queue...</div>
        ) : !data?.queue ? (
          <div className="empty">Scheduler queue not available.</div>
        ) : (
          <div className="template-details-grid">
            <div className="template-kv-item">
              <span className="template-kv-label">Head</span>
              <span className="template-kv-value mono">{shortAddress(data.queue.head)}</span>
            </div>
            <div className="template-kv-item">
              <span className="template-kv-label">Round counter</span>
              <span className="template-kv-value mono">{data.queue.roundCounter || "-"}</span>
            </div>
            <div className="template-kv-item">
              <span className="template-kv-label">Active round started</span>
              <span className="template-kv-value">{formatMs(data.queue.activeRoundStartedMs)}</span>
            </div>
            <div className="template-kv-item">
              <span className="template-kv-label">Last round completed</span>
              <span className="template-kv-value">{formatMs(data.queue.lastRoundCompletedMs)}</span>
            </div>
            <div className="template-kv-item scheduled-queue-item">
              <span className="template-kv-label">Queue nodes</span>
              <span className="template-kv-value">
                {data.queue.nodes.length ? data.queue.nodes.map((item) => shortAddress(item)).join(" -> ") : "-"}
              </span>
            </div>
          </div>
        )}
      </section>

      <section className="card card-spaced">
        <div className="section-title">Task schedules</div>
        {currentAccount && canManageAnyTask ? (
          <div className="summary-hint scheduled-actions-hint">
            Controls are shown when the connected wallet is the task owner or holds the oracle controller cap.
          </div>
        ) : null}
        {currentAccount ? (
          <div className="task-schedules-toolbar">
            <button
              type="button"
              className={`task-schedules-filter-button${showOnlyMine ? " is-active" : ""}`}
              onClick={() => setShowOnlyMine((value) => !value)}
            >
              {showOnlyMine ? "Showing my tasks" : "Show only my tasks"}
            </button>
          </div>
        ) : null}
        {loading ? (
          <div className="empty">Loading task schedules...</div>
        ) : !items.length ? (
          <div className="empty">{showOnlyMine ? "No tasks found for the connected wallet." : "No task schedules found."}</div>
        ) : (
          <div className="table-wrap">
            <table className="responsive-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Template</th>
                  <th>Runs</th>
                  <th>Next run</th>
                  <th>Interval</th>
                  <th>Balance</th>
                  <th>Creator</th>
                  <th>Last scheduler</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const isOwner = connectedAddress && normalizeAddress(item.creator) === connectedAddress;
                  const canShowActions = Boolean(currentAccount && (hasControllerCap || isOwner));
                  const isTerminal = hasTerminalScheduleStatus(item);
                  const isActive = item.statusLabel.toUpperCase() === "ACTIVE";
                  const isEnded = item.statusLabel.toUpperCase() === "ENDED";
                  const isSuspended = item.statusLabel.toUpperCase() === "SUSPENDED";
                  const isDepleted = item.statusLabel.toUpperCase() === "DEPLETED";
                  const isCompleted = item.statusLabel.toUpperCase() === "COMPLETED";
                  const ownerCapId = controls.ownerCapIdsByTaskId[normalizeAddress(item.id)];
                  const busyPrefix = `${item.id}:`;

                  return (
                    <tr
                      key={item.id}
                      className={onSelectTask ? "clickable-row" : undefined}
                      onClick={onSelectTask ? () => onSelectTask(item.id) : undefined}
                      style={onSelectTask ? { cursor: "pointer" } : undefined}
                    >
                      <td data-label="Task">
                        <div className="mono">
                          {onSelectTask ? (
                            <button
                              type="button"
                              className="link-button mono"
                              onClick={(event) => {
                                event.stopPropagation();
                                onSelectTask(item.id);
                              }}
                            >
                              {shortAddress(item.id, 8, 6)}
                            </button>
                          ) : (
                            shortAddress(item.id, 8, 6)
                          )}
                        </div>
                        <div className="summary-hint">Start {formatMs(item.startScheduleMs)}</div>
                      </td>
                      <td data-label="Status">
                        <span className={`template-status-badge ${statusClass(item)}`}>{displayStatusLabel(item)}</span>
                      </td>
                      <td data-label="Template" className="mono">
                        {item.templateId || "-"}
                      </td>
                      <td data-label="Runs" className="mono">
                        {item.runCount || "0"}
                      </td>
                      <td data-label="Next run">
                        <div>{isTerminal ? "-" : formatMs(item.nextRunMs)}</div>
                        <div className="summary-hint">Last {formatMs(item.lastRunMs)}</div>
                      </td>
                      <td data-label="Interval">{formatIntervalMs(item.intervalMs)}</td>
                      <td data-label="Balance">
                        <div className="mono">{item.balanceIota || "0"}</div>
                        <div className="summary-hint">{formatIotaAtomic(item.balanceIota)} IOTA</div>
                      </td>
                      <td data-label="Creator" className="mono">
                        {shortAddress(item.creator)}
                        {connectedAddress && normalizeAddress(item.creator) === connectedAddress ? (
                          <div className="summary-hint">Connected wallet</div>
                        ) : null}
                      </td>
                      <td data-label="Last scheduler" className="mono">
                        {shortAddress(item.lastSchedulerNode)}
                      </td>
                      <td data-label="Actions">
                        {canShowActions ? (
                          <div
                            className="scheduled-actions"
                            onClick={(event) => {
                              event.stopPropagation();
                            }}
                          >
                            <button
                              type="button"
                              className="scheduled-action-button"
                              disabled={(!isOwner && !hasControllerCap) || (!isActive && !isEnded && !isDepleted) || busyActionKey?.startsWith(busyPrefix)}
                              title={isOwner || hasControllerCap ? "Suspend this scheduled task" : "Owner or controller cap required"}
                              onClick={() =>
                                void handleAction(
                                  item,
                                  {
                                    action: "suspend",
                                    useSupervisor: !isOwner,
                                    controllerCapId: !isOwner ? controls.controllerCapId ?? undefined : undefined,
                                  },
                                  "Suspend",
                                )
                              }
                            >
                              Suspend
                            </button>
                            <button
                              type="button"
                              className="scheduled-action-button"
                              disabled={(!isOwner && !hasControllerCap) || (!isSuspended && !isCompleted) || ((!isOwner && !controls.controllerCapId) || (isOwner && !ownerCapId && !hasControllerCap)) || busyActionKey?.startsWith(busyPrefix)}
                              title={isOwner || hasControllerCap ? "Delete this suspended or completed scheduled task" : "Owner or controller cap required"}
                              onClick={() =>
                                void handleAction(
                                  item,
                                  {
                                    action: "delete",
                                    useSupervisor: !isOwner,
                                    controllerCapId: !isOwner ? controls.controllerCapId ?? undefined : undefined,
                                    ownerCapId: isOwner ? ownerCapId : undefined,
                                  },
                                  "Delete",
                                )
                              }
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              className="scheduled-action-button"
                              disabled={!isOwner || (!isSuspended && !isDepleted) || busyActionKey?.startsWith(busyPrefix)}
                              title={isOwner ? "Restart this suspended or depleted scheduled task" : "Only the owner can restart this task"}
                              onClick={() =>
                                void handleAction(
                                  item,
                                  {
                                    action: "reactivate",
                                  },
                                  "Restart",
                                )
                              }
                            >
                              Restart
                            </button>
                            <button
                              type="button"
                              className="scheduled-action-button"
                              disabled={(!isOwner && !hasControllerCap) || busyActionKey?.startsWith(busyPrefix) || controls.loading}
                              title="Add more funds to this scheduled task"
                              onClick={() =>
                                void handleAction(
                                  item,
                                  {
                                    action: "fund",
                                  },
                                  "Funding",
                                )
                              }
                            >
                              Add funds
                            </button>
                          </div>
                        ) : controls.loading && currentAccount ? (
                          <div className="summary-hint">Checking caps...</div>
                        ) : (
                          <span className="summary-hint">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
