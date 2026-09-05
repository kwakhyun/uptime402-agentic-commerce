import {
  IdentifierSchema,
  PositiveBaseUnitsSchema,
  Sha256Schema,
  TimestampSchema,
  type JsonValue,
} from "@uptime402/domain";

export const RESERVATION_STATES = [
  "proposed",
  "reserved",
  "submitted",
  "confirmed",
  "fulfilled",
  "committed",
  "denied",
  "released",
  "unknown",
  "refunded",
] as const;

export type ReservationState = (typeof RESERVATION_STATES)[number];

export type ReservationStateEvent = {
  state: ReservationState;
  at: string;
  note?: string;
};

export type ReservationRecord = {
  reservationId: string;
  incidentId: string;
  mandateId: string;
  paymentId: string;
  nonce: string;
  idempotencyKey: string;
  requestFingerprint: string;
  amountBaseUnits: string;
  budgetDay: string;
  state: ReservationState;
  version: number;
  createdAt: string;
  updatedAt: string;
  stateHistory: ReservationStateEvent[];
  txSignature?: string;
  fulfillmentReceiptHash?: string;
  failureReason?: string;
};

export type ReserveBudgetRequest = {
  reservationId: string;
  incidentId: string;
  mandateId: string;
  paymentId: string;
  nonce: string;
  idempotencyKey: string;
  requestFingerprint: string;
  amountBaseUnits: string;
  incidentLimitBaseUnits: string;
  dailyLimitBaseUnits: string;
  occurredAt: string;
};

export type ReserveBudgetResult =
  | { kind: "reserved"; record: ReservationRecord; budgetBefore: BudgetUsage; budgetAfter: BudgetUsage }
  | { kind: "existing"; record: ReservationRecord }
  | {
      kind: "conflict";
      reason: "reservation_id" | "payment_id" | "nonce" | "idempotency_key" | "mixed_identifier_binding";
      existingReservationId: string;
    }
  | {
      kind: "budget_exceeded";
      scope: "incident" | "daily";
      usedBaseUnits: string;
      attemptedBaseUnits: string;
      limitBaseUnits: string;
      transactionCreated: false;
    };

export type ReservationTransitionPatch = {
  txSignature?: string;
  fulfillmentReceiptHash?: string;
  failureReason?: string;
  note?: string;
};

export type BudgetUsage = {
  incidentCommittedAndReservedBaseUnits: string;
  dailyCommittedAndReservedBaseUnits: string;
};

export type DenialRecord = {
  denialId: string;
  incidentId: string;
  mandateId: string;
  requestFingerprint: string;
  reasonCode: string;
  attemptedAmountBaseUnits: string;
  attemptedAt: string;
  transactionCreated: false;
  txSignature: null;
};

export interface ReservationRepository {
  reserveBudget(request: ReserveBudgetRequest): Promise<ReserveBudgetResult>;
  getReservation(reservationId: string): Promise<ReservationRecord | null>;
  getReservationByPaymentId(paymentId: string): Promise<ReservationRecord | null>;
  getReservationByNonce(nonce: string): Promise<ReservationRecord | null>;
  getReservationByIdempotencyKey(idempotencyKey: string): Promise<ReservationRecord | null>;
  transitionReservation(
    reservationId: string,
    expectedStates: readonly ReservationState[],
    nextState: ReservationState,
    occurredAt: string,
    patch?: ReservationTransitionPatch,
  ): Promise<ReservationRecord>;
  getBudgetUsage(mandateId: string, incidentId: string, occurredAt: string): Promise<BudgetUsage>;
  recordDenial(record: DenialRecord): Promise<void>;
  listDenials(): Promise<DenialRecord[]>;
}

export const VENDOR_CLAIM_STATES = [
  "settling",
  "settlement_verified",
  "resource_generated",
  "receipt_signed",
] as const;

export type VendorClaimState = (typeof VENDOR_CLAIM_STATES)[number];

export type VendorPaymentClaimRecord = {
  vendorTenant: string;
  paymentId: string;
  requestFingerprint: string;
  state: VendorClaimState;
  version: number;
  settlementAttempted: boolean;
  createdAt: string;
  updatedAt: string;
  txSignature?: string;
  resourceResponseHash?: string;
  resourceContentType?: string;
  resourceBodyBase64?: string;
  fulfillmentReceipt?: JsonValue;
};

export type ClaimVendorPaymentRequest = {
  vendorTenant: string;
  paymentId: string;
  requestFingerprint: string;
  occurredAt: string;
};

export type ClaimVendorPaymentResult =
  | { kind: "acquired"; record: VendorPaymentClaimRecord }
  | { kind: "persisted"; record: VendorPaymentClaimRecord }
  | {
      kind: "reconcile_required";
      record: VendorPaymentClaimRecord;
      reason: "ambiguous_settling" | "incomplete_fulfillment";
    }
  | { kind: "conflict"; httpStatus: 409; record: VendorPaymentClaimRecord };

export type VendorClaimTransitionPatch = {
  txSignature?: string;
  resourceResponseHash?: string;
  resourceContentType?: string;
  resourceBodyBase64?: string;
  fulfillmentReceipt?: JsonValue;
};

export interface VendorClaimRepository {
  claimVendorPayment(request: ClaimVendorPaymentRequest): Promise<ClaimVendorPaymentResult>;
  getVendorPaymentClaim(vendorTenant: string, paymentId: string): Promise<VendorPaymentClaimRecord | null>;
  markVendorSettlementAttempted(
    vendorTenant: string,
    paymentId: string,
    expectedVersion: number,
    occurredAt: string,
  ): Promise<VendorPaymentClaimRecord>;
  transitionVendorPaymentClaim(
    vendorTenant: string,
    paymentId: string,
    expectedState: VendorClaimState,
    expectedVersion: number,
    nextState: VendorClaimState,
    occurredAt: string,
    patch?: VendorClaimTransitionPatch,
  ): Promise<VendorPaymentClaimRecord>;
  releaseVendorClaimBeforeSubmission(
    vendorTenant: string,
    paymentId: string,
    expectedVersion: number,
  ): Promise<boolean>;
}

export interface TransactionalPersistence extends ReservationRepository, VendorClaimRepository {}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class InMemoryPersistenceBackend {
  readonly mutex = new AsyncMutex();
  readonly reservations = new Map<string, ReservationRecord>();
  readonly reservationByPaymentId = new Map<string, string>();
  readonly reservationByNonce = new Map<string, string>();
  readonly reservationByIdempotencyKey = new Map<string, string>();
  readonly denials = new Map<string, DenialRecord>();
  readonly vendorClaims = new Map<string, VendorPaymentClaimRecord>();
}

const ALLOWED_RESERVATION_TRANSITIONS: Readonly<Record<ReservationState, readonly ReservationState[]>> = {
  proposed: ["reserved", "denied"],
  reserved: ["submitted", "released"],
  submitted: ["confirmed", "unknown"],
  confirmed: ["fulfilled", "refunded"],
  fulfilled: ["committed", "refunded"],
  committed: ["refunded"],
  denied: [],
  released: [],
  unknown: ["confirmed", "released"],
  refunded: [],
};

const ALLOWED_VENDOR_TRANSITIONS: Readonly<Record<VendorClaimState, readonly VendorClaimState[]>> = {
  settling: ["settlement_verified"],
  settlement_verified: ["resource_generated"],
  resource_generated: ["receipt_signed"],
  receipt_signed: [],
};

const BUDGET_HOLDING_STATES = new Set<ReservationState>([
  "reserved",
  "submitted",
  "confirmed",
  "fulfilled",
  "committed",
  "unknown",
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parsePositiveBaseUnits(value: string, field: string): bigint {
  const parsed = PositiveBaseUnitsSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`${field} must be a positive integer base-unit string`);
  }
  return BigInt(parsed.data);
}

function validateTimestamp(value: string, field: string): void {
  if (!TimestampSchema.safeParse(value).success) {
    throw new TypeError(`${field} must be a timezone-aware timestamp`);
  }
}

function budgetDay(timestamp: string): string {
  validateTimestamp(timestamp, "occurredAt");
  return new Date(timestamp).toISOString().slice(0, 10);
}

function vendorClaimKey(vendorTenant: string, paymentId: string): string {
  return JSON.stringify([vendorTenant, paymentId]);
}

function sameReservationRequest(record: ReservationRecord, request: ReserveBudgetRequest): boolean {
  return (
    record.reservationId === request.reservationId &&
    record.incidentId === request.incidentId &&
    record.mandateId === request.mandateId &&
    record.paymentId === request.paymentId &&
    record.nonce === request.nonce &&
    record.idempotencyKey === request.idempotencyKey &&
    record.requestFingerprint === request.requestFingerprint &&
    record.amountBaseUnits === request.amountBaseUnits
  );
}

function validateReserveRequest(request: ReserveBudgetRequest): void {
  for (const [field, value] of Object.entries({
    reservationId: request.reservationId,
    incidentId: request.incidentId,
    mandateId: request.mandateId,
    paymentId: request.paymentId,
    nonce: request.nonce,
    idempotencyKey: request.idempotencyKey,
  })) {
    if (!IdentifierSchema.safeParse(value).success) {
      throw new TypeError(`${field} is invalid`);
    }
  }
  if (!Sha256Schema.safeParse(request.requestFingerprint).success) {
    throw new TypeError("requestFingerprint is invalid");
  }
  parsePositiveBaseUnits(request.amountBaseUnits, "amountBaseUnits");
  parsePositiveBaseUnits(request.incidentLimitBaseUnits, "incidentLimitBaseUnits");
  parsePositiveBaseUnits(request.dailyLimitBaseUnits, "dailyLimitBaseUnits");
  validateTimestamp(request.occurredAt, "occurredAt");
}

export class InMemoryTransactionalRepository implements TransactionalPersistence {
  constructor(private readonly backend: InMemoryPersistenceBackend = new InMemoryPersistenceBackend()) {}

  async reserveBudget(request: ReserveBudgetRequest): Promise<ReserveBudgetResult> {
    validateReserveRequest(request);
    return this.backend.mutex.runExclusive(() => {
      const directRecord = this.backend.reservations.get(request.reservationId);
      const identifierIds = [
        this.backend.reservationByPaymentId.get(request.paymentId),
        this.backend.reservationByNonce.get(request.nonce),
        this.backend.reservationByIdempotencyKey.get(request.idempotencyKey),
      ].filter((value): value is string => value !== undefined);
      const boundIds = new Set(identifierIds);

      if (directRecord && sameReservationRequest(directRecord, request) && (boundIds.size === 0 || boundIds.has(directRecord.reservationId))) {
        return { kind: "existing", record: clone(directRecord) };
      }

      if (directRecord) {
        return {
          kind: "conflict",
          reason: "reservation_id",
          existingReservationId: directRecord.reservationId,
        };
      }

      if (boundIds.size > 1) {
        return {
          kind: "conflict",
          reason: "mixed_identifier_binding",
          existingReservationId: [...boundIds].sort()[0]!,
        };
      }

      if (boundIds.size === 1) {
        const existingReservationId = [...boundIds][0]!;
        const existing = this.backend.reservations.get(existingReservationId)!;
        if (sameReservationRequest(existing, request)) {
          return { kind: "existing", record: clone(existing) };
        }
        const reason = this.backend.reservationByPaymentId.get(request.paymentId)
          ? "payment_id"
          : this.backend.reservationByNonce.get(request.nonce)
            ? "nonce"
            : "idempotency_key";
        return { kind: "conflict", reason, existingReservationId };
      }

      const amount = parsePositiveBaseUnits(request.amountBaseUnits, "amountBaseUnits");
      const incidentLimit = parsePositiveBaseUnits(request.incidentLimitBaseUnits, "incidentLimitBaseUnits");
      const dailyLimit = parsePositiveBaseUnits(request.dailyLimitBaseUnits, "dailyLimitBaseUnits");
      const day = budgetDay(request.occurredAt);
      let incidentUsed = 0n;
      let dailyUsed = 0n;
      for (const record of this.backend.reservations.values()) {
        if (record.mandateId !== request.mandateId || !BUDGET_HOLDING_STATES.has(record.state)) {
          continue;
        }
        const recordAmount = BigInt(record.amountBaseUnits);
        if (record.incidentId === request.incidentId) {
          incidentUsed += recordAmount;
        }
        if (record.budgetDay === day) {
          dailyUsed += recordAmount;
        }
      }

      if (incidentUsed + amount > incidentLimit) {
        return {
          kind: "budget_exceeded",
          scope: "incident",
          usedBaseUnits: incidentUsed.toString(),
          attemptedBaseUnits: request.amountBaseUnits,
          limitBaseUnits: request.incidentLimitBaseUnits,
          transactionCreated: false,
        };
      }
      if (dailyUsed + amount > dailyLimit) {
        return {
          kind: "budget_exceeded",
          scope: "daily",
          usedBaseUnits: dailyUsed.toString(),
          attemptedBaseUnits: request.amountBaseUnits,
          limitBaseUnits: request.dailyLimitBaseUnits,
          transactionCreated: false,
        };
      }

      const record: ReservationRecord = {
        reservationId: request.reservationId,
        incidentId: request.incidentId,
        mandateId: request.mandateId,
        paymentId: request.paymentId,
        nonce: request.nonce,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: request.requestFingerprint,
        amountBaseUnits: request.amountBaseUnits,
        budgetDay: day,
        state: "reserved",
        version: 1,
        createdAt: request.occurredAt,
        updatedAt: request.occurredAt,
        stateHistory: [
          { state: "proposed", at: request.occurredAt },
          { state: "reserved", at: request.occurredAt },
        ],
      };
      this.backend.reservations.set(record.reservationId, record);
      this.backend.reservationByPaymentId.set(record.paymentId, record.reservationId);
      this.backend.reservationByNonce.set(record.nonce, record.reservationId);
      this.backend.reservationByIdempotencyKey.set(record.idempotencyKey, record.reservationId);
      return {
        kind: "reserved", record: clone(record),
        budgetBefore: {
          incidentCommittedAndReservedBaseUnits: incidentUsed.toString(),
          dailyCommittedAndReservedBaseUnits: dailyUsed.toString(),
        },
        budgetAfter: {
          incidentCommittedAndReservedBaseUnits: (incidentUsed + amount).toString(),
          dailyCommittedAndReservedBaseUnits: (dailyUsed + amount).toString(),
        },
      };
    });
  }

  async getReservation(reservationId: string): Promise<ReservationRecord | null> {
    const record = this.backend.reservations.get(reservationId);
    return record ? clone(record) : null;
  }

  async getReservationByPaymentId(paymentId: string): Promise<ReservationRecord | null> {
    const reservationId = this.backend.reservationByPaymentId.get(paymentId);
    return reservationId ? this.getReservation(reservationId) : null;
  }

  async getReservationByNonce(nonce: string): Promise<ReservationRecord | null> {
    const reservationId = this.backend.reservationByNonce.get(nonce);
    return reservationId ? this.getReservation(reservationId) : null;
  }

  async getReservationByIdempotencyKey(idempotencyKey: string): Promise<ReservationRecord | null> {
    const reservationId = this.backend.reservationByIdempotencyKey.get(idempotencyKey);
    return reservationId ? this.getReservation(reservationId) : null;
  }

  async transitionReservation(
    reservationId: string,
    expectedStates: readonly ReservationState[],
    nextState: ReservationState,
    occurredAt: string,
    patch: ReservationTransitionPatch = {},
  ): Promise<ReservationRecord> {
    validateTimestamp(occurredAt, "occurredAt");
    return this.backend.mutex.runExclusive(() => {
      const record = this.backend.reservations.get(reservationId);
      if (!record) {
        throw new Error(`Reservation not found: ${reservationId}`);
      }
      if (!expectedStates.includes(record.state)) {
        throw new Error(`Reservation ${reservationId} is ${record.state}, expected ${expectedStates.join(" or ")}`);
      }
      if (!ALLOWED_RESERVATION_TRANSITIONS[record.state].includes(nextState)) {
        throw new Error(`Illegal reservation transition ${record.state} -> ${nextState}`);
      }
      if ((nextState === "confirmed" || nextState === "fulfilled" || nextState === "committed") && !(patch.txSignature ?? record.txSignature)) {
        throw new Error(`${nextState} requires a transaction signature`);
      }
      if ((nextState === "fulfilled" || nextState === "committed") && !(patch.fulfillmentReceiptHash ?? record.fulfillmentReceiptHash)) {
        throw new Error(`${nextState} requires a fulfillment receipt hash`);
      }

      const updated: ReservationRecord = {
        ...record,
        ...(patch.txSignature ? { txSignature: patch.txSignature } : {}),
        ...(patch.fulfillmentReceiptHash ? { fulfillmentReceiptHash: patch.fulfillmentReceiptHash } : {}),
        ...(patch.failureReason ? { failureReason: patch.failureReason } : {}),
        state: nextState,
        version: record.version + 1,
        updatedAt: occurredAt,
        stateHistory: [
          ...record.stateHistory,
          { state: nextState, at: occurredAt, ...(patch.note ? { note: patch.note } : {}) },
        ],
      };
      this.backend.reservations.set(reservationId, updated);
      return clone(updated);
    });
  }

  async getBudgetUsage(mandateId: string, incidentId: string, occurredAt: string): Promise<BudgetUsage> {
    const day = budgetDay(occurredAt);
    return this.backend.mutex.runExclusive(() => {
      let incident = 0n;
      let daily = 0n;
      for (const record of this.backend.reservations.values()) {
        if (record.mandateId !== mandateId || !BUDGET_HOLDING_STATES.has(record.state)) {
          continue;
        }
        const amount = BigInt(record.amountBaseUnits);
        if (record.incidentId === incidentId) incident += amount;
        if (record.budgetDay === day) daily += amount;
      }
      return {
        incidentCommittedAndReservedBaseUnits: incident.toString(),
        dailyCommittedAndReservedBaseUnits: daily.toString(),
      };
    });
  }

  async recordDenial(record: DenialRecord): Promise<void> {
    if (!IdentifierSchema.safeParse(record.denialId).success) throw new TypeError("denialId is invalid");
    if (!Sha256Schema.safeParse(record.requestFingerprint).success) throw new TypeError("requestFingerprint is invalid");
    parsePositiveBaseUnits(record.attemptedAmountBaseUnits, "attemptedAmountBaseUnits");
    validateTimestamp(record.attemptedAt, "attemptedAt");
    if (record.transactionCreated !== false || record.txSignature !== null) {
      throw new TypeError("Denial records cannot contain a transaction");
    }
    await this.backend.mutex.runExclusive(() => {
      const existing = this.backend.denials.get(record.denialId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(`Denial ID conflict: ${record.denialId}`);
      }
      this.backend.denials.set(record.denialId, clone(record));
    });
  }

  async listDenials(): Promise<DenialRecord[]> {
    return [...this.backend.denials.values()].map(clone);
  }

  async claimVendorPayment(request: ClaimVendorPaymentRequest): Promise<ClaimVendorPaymentResult> {
    if (!IdentifierSchema.safeParse(request.vendorTenant).success) throw new TypeError("vendorTenant is invalid");
    if (!IdentifierSchema.safeParse(request.paymentId).success) throw new TypeError("paymentId is invalid");
    if (!Sha256Schema.safeParse(request.requestFingerprint).success) throw new TypeError("requestFingerprint is invalid");
    validateTimestamp(request.occurredAt, "occurredAt");

    return this.backend.mutex.runExclusive(() => {
      const key = vendorClaimKey(request.vendorTenant, request.paymentId);
      const existing = this.backend.vendorClaims.get(key);
      if (!existing) {
        const record: VendorPaymentClaimRecord = {
          vendorTenant: request.vendorTenant,
          paymentId: request.paymentId,
          requestFingerprint: request.requestFingerprint,
          state: "settling",
          version: 1,
          settlementAttempted: false,
          createdAt: request.occurredAt,
          updatedAt: request.occurredAt,
        };
        this.backend.vendorClaims.set(key, record);
        return { kind: "acquired", record: clone(record) };
      }
      if (existing.requestFingerprint !== request.requestFingerprint) {
        return { kind: "conflict", httpStatus: 409, record: clone(existing) };
      }
      if (existing.state === "receipt_signed") {
        return { kind: "persisted", record: clone(existing) };
      }
      return {
        kind: "reconcile_required",
        record: clone(existing),
        reason: existing.state === "settling" ? "ambiguous_settling" : "incomplete_fulfillment",
      };
    });
  }

  async getVendorPaymentClaim(vendorTenant: string, paymentId: string): Promise<VendorPaymentClaimRecord | null> {
    const record = this.backend.vendorClaims.get(vendorClaimKey(vendorTenant, paymentId));
    return record ? clone(record) : null;
  }

  async markVendorSettlementAttempted(
    vendorTenant: string,
    paymentId: string,
    expectedVersion: number,
    occurredAt: string,
  ): Promise<VendorPaymentClaimRecord> {
    validateTimestamp(occurredAt, "occurredAt");
    return this.backend.mutex.runExclusive(() => {
      const key = vendorClaimKey(vendorTenant, paymentId);
      const record = this.backend.vendorClaims.get(key);
      if (!record) throw new Error(`Vendor claim not found: ${vendorTenant}/${paymentId}`);
      if (record.state !== "settling" || record.version !== expectedVersion) {
        throw new Error("Vendor claim changed before settlement attempt");
      }
      const updated: VendorPaymentClaimRecord = {
        ...record,
        settlementAttempted: true,
        version: record.version + 1,
        updatedAt: occurredAt,
      };
      this.backend.vendorClaims.set(key, updated);
      return clone(updated);
    });
  }

  async transitionVendorPaymentClaim(
    vendorTenant: string,
    paymentId: string,
    expectedState: VendorClaimState,
    expectedVersion: number,
    nextState: VendorClaimState,
    occurredAt: string,
    patch: VendorClaimTransitionPatch = {},
  ): Promise<VendorPaymentClaimRecord> {
    validateTimestamp(occurredAt, "occurredAt");
    return this.backend.mutex.runExclusive(() => {
      const key = vendorClaimKey(vendorTenant, paymentId);
      const record = this.backend.vendorClaims.get(key);
      if (!record) throw new Error(`Vendor claim not found: ${vendorTenant}/${paymentId}`);
      if (record.state !== expectedState || record.version !== expectedVersion) {
        throw new Error("Vendor claim state/version precondition failed");
      }
      if (!ALLOWED_VENDOR_TRANSITIONS[record.state].includes(nextState)) {
        throw new Error(`Illegal vendor claim transition ${record.state} -> ${nextState}`);
      }
      const txSignature = patch.txSignature ?? record.txSignature;
      const responseHash = patch.resourceResponseHash ?? record.resourceResponseHash;
      const receipt = patch.fulfillmentReceipt ?? record.fulfillmentReceipt;
      if (nextState === "settlement_verified" && (!record.settlementAttempted || !txSignature)) {
        throw new Error("Verified settlement requires an attempted settlement and transaction signature");
      }
      if (nextState === "resource_generated" && (!txSignature || !responseHash || !patch.resourceContentType || !patch.resourceBodyBase64)) {
        throw new Error("Generated resource requires settlement and persisted response bytes");
      }
      if (nextState === "receipt_signed" && (!txSignature || !responseHash || !receipt)) {
        throw new Error("Signed receipt requires settlement and generated resource bindings");
      }
      const updated: VendorPaymentClaimRecord = {
        ...record,
        ...patch,
        state: nextState,
        version: record.version + 1,
        updatedAt: occurredAt,
      };
      this.backend.vendorClaims.set(key, updated);
      return clone(updated);
    });
  }

  async releaseVendorClaimBeforeSubmission(
    vendorTenant: string,
    paymentId: string,
    expectedVersion: number,
  ): Promise<boolean> {
    return this.backend.mutex.runExclusive(() => {
      const key = vendorClaimKey(vendorTenant, paymentId);
      const record = this.backend.vendorClaims.get(key);
      if (!record) return false;
      if (record.state !== "settling" || record.version !== expectedVersion || record.settlementAttempted) {
        return false;
      }
      this.backend.vendorClaims.delete(key);
      return true;
    });
  }
}

export * from "./firestore.js";
export * from "./runtime-state.js";

export * from "./recovery-checkpoints.js";
