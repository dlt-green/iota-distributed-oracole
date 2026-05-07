// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { MultiSigPublicKey } from "@iota/iota-sdk/multisig";
import { Ed25519PublicKey } from "@iota/iota-sdk/keypairs/ed25519";
import { sha256 } from "@noble/hashes/sha256";

export type WeightedSigner = {
  pubKeyBase64: string;
  weight?: number;
};

export type RegisteredNodeLike = {
  nodeId?: string | number;
  id?: string | number;
  address?: string;
  pubkey?: unknown;
};

export type TaskMultisigLike = {
  multisig_addr?: string | null;
  multisig_bytes?: unknown;
  assigned_nodes?: Array<string | number>;
  certificate_signers?: Array<string | number>;
  quorum_k?: number | string;
  result?: unknown;
  result_bytes?: number[] | Uint8Array | string | null;
  result_hash?: number[] | Uint8Array | string | null;
};

export type TaskMultisigValidation = {
  storedAddress: string;
  derivedAddress: string | null;
  addressMatch: boolean;
  addressStatus: "match" | "stored_is_signer" | "mismatch" | "unverifiable";
  derivedError: string | null;
  certificateStatus: "valid" | "below_quorum" | "unknown_signer" | "duplicate_signer" | "empty";
  multisigBytesBase64: string | null;
  multisigBytesLength: number;
  signerRows: Array<{
    signerId: string;
    found: boolean;
    address?: string;
    pubkeyBase64?: string;
    error?: string;
  }>;
  resultHashHex: string | null;
  multisigDebug: any;
};

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (!clean || clean.length % 2 !== 0) {
    throw new Error("Invalid hex value");
  }

  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const value = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(value)) throw new Error("Invalid hex value");
    out[i] = value;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function normalizeId(value: unknown): string {
  return String(value ?? "").trim();
}

function canonicalIds(values: Array<string | number>): string[] {
  return values
    .map((value) => normalizeId(value).toLowerCase())
    .filter(Boolean)
    .sort();
}

function normalizeAddress(value: unknown): string {
  const t = String(value ?? "").trim().toLowerCase();
  if (!t) return "";
  return t.startsWith("0x") ? t : `0x${t}`;
}

function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = window.atob(base64);
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
    if (trimmed.startsWith("0x") || /^[0-9a-fA-F]+$/.test(trimmed)) return hexToBytes(trimmed);
    return base64ToBytes(trimmed);
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["bytes", "pubkey", "value", "data", "contents"]) {
      if (key in obj) return toUint8Array(obj[key]);
    }
  }

  return null;
}

function bytesToHex(bytes: Uint8Array | null | undefined): string {
  if (!bytes || bytes.length === 0) return "";
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

export function buildMultiSigFromBase64(threshold: number, signers: WeightedSigner[]) {
  return MultiSigPublicKey.fromPublicKeys({
    threshold,
    publicKeys: signers.map((s) => ({
      publicKey: new Ed25519PublicKey(s.pubKeyBase64),
      weight: s.weight ?? 1,
    })),
  });
}

export function deriveAddressFromSignerSet(threshold: number, signers: WeightedSigner[]) {
  return buildMultiSigFromBase64(threshold, signers).toIotaAddress();
}

export function computeResultHash(resultBytes: Uint8Array) {
  return sha256(resultBytes);
}

export function normalizePubkeyToBase64(value: unknown): string {
  if (typeof value === "string") {
    const v = value.trim();
    if (!v) throw new Error("Empty pubkey");
    if (v.startsWith("0x") || /^[0-9a-fA-F]+$/.test(v)) {
      return bytesToBase64(hexToBytes(v));
    }
    return v;
  }

  if (value instanceof Uint8Array) {
    return bytesToBase64(value);
  }

  if (Array.isArray(value)) {
    return bytesToBase64(Uint8Array.from(value as number[]));
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["bytes", "pubkey", "value", "data"]) {
      if (key in obj) return normalizePubkeyToBase64(obj[key]);
    }
  }

  throw new Error("Unsupported pubkey format");
}

export function validateTaskMultisig(
  task: TaskMultisigLike | null | undefined,
  registeredNodes: RegisteredNodeLike[],
): TaskMultisigValidation {
  if (!task) {
    return {
      storedAddress: "",
      derivedAddress: null,
      addressMatch: false,
      addressStatus: "unverifiable",
      derivedError: "No task loaded.",
      certificateStatus: "empty",
      multisigBytesBase64: null,
      multisigBytesLength: 0,
      signerRows: [],
      resultHashHex: null,
      multisigDebug: null,
    };
  }

  const committeeIds = Array.isArray(task.assigned_nodes)
    ? canonicalIds(task.assigned_nodes)
    : [];
  const signerIds = Array.isArray(task.certificate_signers)
    ? canonicalIds(task.certificate_signers)
    : [];

  const thresholdRaw = task.quorum_k;
  const threshold = Number(thresholdRaw);
  const storedAddress = String(task.multisig_addr ?? "").trim();
  const multisigDebug = decodeAsciiJson(task.multisig_bytes);

  const orderedSignerIds =
    multisigDebug && Array.isArray(multisigDebug.signers)
      ? canonicalIds(multisigDebug.signers as Array<string | number>)
      : signerIds;

  const committeeSourceIds = committeeIds.length > 0 ? committeeIds : orderedSignerIds;

  const committeeRows = committeeSourceIds.map((memberId: string) => {
    const memberIdLc = memberId.toLowerCase();
    const node =
      registeredNodes.find((n) => normalizeId(n.address).toLowerCase() === memberIdLc) ??
      registeredNodes.find((n) => normalizeId(n.nodeId).toLowerCase() === memberIdLc) ??
      registeredNodes.find((n) => normalizeId(n.id).toLowerCase() === memberIdLc);

    if (!node) {
      return { signerId: memberId, found: false, error: "Registered node not found" };
    }

    try {
      const pubkeyBase64 = normalizePubkeyToBase64(node.pubkey);
      return { signerId: memberId, found: true, address: node.address, pubkeyBase64 };
    } catch (error) {
      return {
        signerId: memberId,
        found: true,
        address: node.address,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const signerRows: TaskMultisigValidation["signerRows"] = orderedSignerIds.map((signerId: string) => {
    const signerIdLc = signerId.toLowerCase();
    const match = committeeRows.find((row) => normalizeId(row.address).toLowerCase() === signerIdLc || row.signerId.toLowerCase() === signerIdLc);
    if (match) return { ...match, signerId };
    return { signerId, found: false, error: "Signer not present in assigned node set" };
  });

  const validCommitteePubkeys = committeeRows
    .filter((row: TaskMultisigValidation["signerRows"][number]) => !!row.pubkeyBase64)
    .map((row: TaskMultisigValidation["signerRows"][number]) => ({ pubKeyBase64: row.pubkeyBase64 as string, weight: 1 }));

  let derivedAddress: string | null = null;
  let derivedError: string | null = null;

  try {
    if (!Number.isFinite(threshold) || threshold <= 0) {
      derivedError = `Invalid quorum_k on task: ${String(thresholdRaw)}`;
    } else if (validCommitteePubkeys.length < threshold) {
      derivedError = `Not enough assigned node pubkeys to derive multisig. threshold=${threshold}, found=${validCommitteePubkeys.length}`;
    } else {
      derivedAddress = deriveAddressFromSignerSet(threshold, validCommitteePubkeys);
    }
  } catch (error) {
    derivedError = error instanceof Error ? error.message : String(error);
  }

  const signerAddresses = signerRows
    .map((row: TaskMultisigValidation["signerRows"][number]) => normalizeAddress(row.address))
    .filter(Boolean);
  const normalizedStoredAddress = normalizeAddress(storedAddress);
  const normalizedDerivedAddress = normalizeAddress(derivedAddress);
  const storedMatchesSigner =
    !!normalizedStoredAddress && signerAddresses.some((addr: string) => addr === normalizedStoredAddress);

  let addressStatus: TaskMultisigValidation["addressStatus"] = "unverifiable";
  if (!normalizedStoredAddress || !normalizedDerivedAddress) {
    addressStatus = "unverifiable";
  } else if (normalizedStoredAddress === normalizedDerivedAddress) {
    addressStatus = "match";
  } else if (storedMatchesSigner) {
    addressStatus = "stored_is_signer";
  } else {
    addressStatus = "mismatch";
  }

  const resultHashBytes =
    toUint8Array(task.result_hash) ??
    (() => {
      const resultBytes = toUint8Array(task.result_bytes ?? task.result);
      return resultBytes ? computeResultHash(resultBytes) : null;
    })();
  const multisigRawBytes = toUint8Array(task.multisig_bytes);

  const uniqueSignerIds = new Set(orderedSignerIds.map((id) => id.toLowerCase()));
  const unknownSignerPresent = signerRows.some((row) => !row.found);
  let certificateStatus: TaskMultisigValidation["certificateStatus"] = "valid";
  if (orderedSignerIds.length === 0) {
    certificateStatus = "empty";
  } else if (uniqueSignerIds.size !== orderedSignerIds.length) {
    certificateStatus = "duplicate_signer";
  } else if (unknownSignerPresent) {
    certificateStatus = "unknown_signer";
  } else if (Number.isFinite(threshold) && orderedSignerIds.length < threshold) {
    certificateStatus = "below_quorum";
  }

  return {
    storedAddress,
    derivedAddress,
    addressMatch:
      !!normalizedStoredAddress && !!normalizedDerivedAddress && normalizedStoredAddress === normalizedDerivedAddress,
    addressStatus,
    derivedError,
    certificateStatus,
    multisigBytesBase64: multisigRawBytes ? bytesToBase64(multisigRawBytes) : null,
    multisigBytesLength: multisigRawBytes?.length ?? 0,
    signerRows,
    resultHashHex: resultHashBytes ? bytesToHex(resultHashBytes) : null,
    multisigDebug,
  };
}
