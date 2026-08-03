import {
  Firestore,
  type DocumentReference,
  type DocumentSnapshot,
  type Transaction,
} from "@google-cloud/firestore";

import {
  BaseUnitsSchema,
  ExecutionPolicySchema,
  IdentifierSchema,
  MandateSchema,
  PositiveBaseUnitsSchema,
  Sha256Schema,
  TimestampSchema,
  VendorOfferSchema,
  canonicalHash,
  computeExecutionPolicyHash,
  computeMandateHash,
  type ExecutionPolicy,
  type JsonValue,
  type Mandate,
  type VendorOffer,
} from "@uptime402/domain";

import type {
  BudgetUsage,
  ClaimVendorPaymentRequest,
  ClaimVendorPaymentResult,
  DenialRecord,
  ReservationRecord,
  ReservationRepository,
  ReservationState,
  ReservationTransitionPatch,
  ReserveBudgetRequest,
  ReserveBudgetResult,
  TransactionalPersistence,
  VendorClaimRepository,
  VendorClaimState,
  VendorClaimTransitionPatch,
  VendorPaymentClaimRecord,
} from "./index.js";

const RESERVATION_STATE_VALUES: readonly ReservationState[] = [
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
];

const VENDOR_CLAIM_STATE_VALUES: readonly VendorClaimState[] = [
  "settling",
  "settlement_verified",
  "resource_generated",
  "receipt_signed",
];

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

type StoredEnvelope = {
  schemaVersion: "1";
  recordHash: `sha256:${string}`;
  value: unknown;
};

type IdentifierBindingRecord = {
  kind: "paymentId" | "nonce" | "idempotencyKey";
  value: string;
  reservationId: string;
  requestFingerprint: string;
  createdAt: string;
};

type BudgetCounterRecord = {
  scope: "incident" | "daily";
  mandateId: string;
  incidentId?: string;
  budgetDay?: string;
  heldBaseUnits: string;
  version: number;
  updatedAt: string;
};

export type AuthoritativeChallengeRecord = {
  challengeId: string;
  challengeHash: `sha256:${string}`;
  paymentId: string;
  operationId: string;
  expiresAt: string;
  capturedAt: string;
  payload: JsonValue;
};

export type ImmutablePutResult<T> =
  | { kind: "stored"; record: T }
  | { kind: "existing"; record: T };

export type AuthoritativePaymentContext = {
  mandate: Mandate;
  executionPolicy: ExecutionPolicy;
  offer: VendorOffer;
  challenge: AuthoritativeChallengeRecord;
};

export interface AuthoritativeRecordRepository {
  putMandate(record: Mandate): Promise<ImmutablePutResult<Mandate>>;
  getMandate(mandateId: string): Promise<Mandate | null>;
  putExecutionPolicy(record: ExecutionPolicy): Promise<ImmutablePutResult<ExecutionPolicy>>;
  getExecutionPolicy(policyId: string): Promise<ExecutionPolicy | null>;
  putOffer(record: VendorOffer): Promise<ImmutablePutResult<VendorOffer>>;
  getOffer(offerId: string): Promise<VendorOffer | null>;
  putChallenge(record: AuthoritativeChallengeRecord): Promise<ImmutablePutResult<AuthoritativeChallengeRecord>>;
  getChallenge(challengeId: string): Promise<AuthoritativeChallengeRecord | null>;
  loadAuthoritativePaymentContext(ids: {
    mandateId: string;
    executionPolicyId: string;
    offerId: string;
    challengeId: string;
  }): Promise<AuthoritativePaymentContext>;
}

export type AuditEventInput = {
  eventId: string;
  type: string;
  occurredAt: string;
  correlationId?: string;
  incidentId?: string;
  mandateId?: string;
  paymentId?: string;
  idempotencyKey?: string;
  txSignature?: string;
  payload: JsonValue;
};

export type AuditEventRecord = AuditEventInput & {
  eventHash: `sha256:${string}`;
};

export interface AuditEventRepository {
  recordAuditEvent(event: AuditEventInput): Promise<ImmutablePutResult<AuditEventRecord>>;
  listAuditEvents(limit?: number): Promise<AuditEventRecord[]>;
}

export type FirestorePersistenceOptions = {
  collectionPrefix?: string;
  transactionMaxAttempts?: number;
};

export type FirestoreClientOptions = ConstructorParameters<typeof Firestore>[0];

export class ImmutableRecordConflictError extends Error {
  readonly collectionName: string;
  readonly recordId: string;

  constructor(collectionName: string, recordId: string) {
    super(`Immutable record conflict at ${collectionName}/${recordId}`);
    this.name = "ImmutableRecordConflictError";
    this.collectionName = collectionName;
    this.recordId = recordId;
  }
}

export class FirestoreDataIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirestoreDataIntegrityError";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowlist = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowlist.has(key));
  if (unexpected.length > 0) {
    throw new FirestoreDataIntegrityError(`${label} contains unexpected fields: ${unexpected.sort().join(",")}`);
  }
}

function requireString(value: Record<string, unknown>, field: string): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string") {
    throw new FirestoreDataIntegrityError(`${field} must be a string`);
  }
  return fieldValue;
}

function requireNumber(value: Record<string, unknown>, field: string): number {
  const fieldValue = value[field];
  if (typeof fieldValue !== "number" || !Number.isInteger(fieldValue)) {
    throw new FirestoreDataIntegrityError(`${field} must be an integer`);
  }
  return fieldValue;
}

function requireBoolean(value: Record<string, unknown>, field: string): boolean {
  const fieldValue = value[field];
  if (typeof fieldValue !== "boolean") {
    throw new FirestoreDataIntegrityError(`${field} must be a boolean`);
  }
  return fieldValue;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function makeEnvelope<T>(value: T): StoredEnvelope {
  return { schemaVersion: "1", recordHash: canonicalHash(value), value: clone(value) };
}

function parseEnvelope<T>(
  snapshot: DocumentSnapshot,
  parser: (value: unknown) => T,
): T | null {
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  if (!isPlainRecord(data)) {
    throw new FirestoreDataIntegrityError(`Invalid envelope at ${snapshot.ref.path}`);
  }
  assertExactKeys(data, ["schemaVersion", "recordHash", "value"], "stored envelope");
  if (data.schemaVersion !== "1" || typeof data.recordHash !== "string" || !Sha256Schema.safeParse(data.recordHash).success) {
    throw new FirestoreDataIntegrityError(`Invalid envelope metadata at ${snapshot.ref.path}`);
  }
  if (canonicalHash(data.value) !== data.recordHash) {
    throw new FirestoreDataIntegrityError(`Canonical record hash mismatch at ${snapshot.ref.path}`);
  }
  return parser(data.value);
}

function parsePositiveBaseUnits(value: string, field: string): bigint {
  const parsed = PositiveBaseUnitsSchema.safeParse(value);
  if (!parsed.success) throw new TypeError(`${field} must be a positive integer base-unit string`);
  return BigInt(parsed.data);
}

function parseBaseUnits(value: string, field: string): bigint {
  const parsed = BaseUnitsSchema.safeParse(value);
  if (!parsed.success) throw new FirestoreDataIntegrityError(`${field} must be a base-unit string`);
  return BigInt(parsed.data);
}

function validateTimestamp(value: string, field: string): void {
  if (!TimestampSchema.safeParse(value).success) throw new TypeError(`${field} must be a timezone-aware timestamp`);
}

function validateIdentifier(value: string, field: string): void {
  if (!IdentifierSchema.safeParse(value).success) throw new TypeError(`${field} is invalid`);
}

function budgetDay(timestamp: string): string {
  validateTimestamp(timestamp, "occurredAt");
  return new Date(timestamp).toISOString().slice(0, 10);
}

function hashDocumentId(namespace: string, parts: readonly string[]): string {
  return canonicalHash({ namespace, parts }).slice("sha256:".length);
}

function validateCollectionPrefix(prefix: string): void {
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(prefix)) {
    throw new TypeError("collectionPrefix must match ^[a-z][a-z0-9_-]{0,47}$");
  }
}

function validateReserveRequest(request: ReserveBudgetRequest): void {
  validateIdentifier(request.reservationId, "reservationId");
  validateIdentifier(request.incidentId, "incidentId");
  validateIdentifier(request.mandateId, "mandateId");
  validateIdentifier(request.paymentId, "paymentId");
  validateIdentifier(request.nonce, "nonce");
  validateIdentifier(request.idempotencyKey, "idempotencyKey");
  if (!Sha256Schema.safeParse(request.requestFingerprint).success) throw new TypeError("requestFingerprint is invalid");
  parsePositiveBaseUnits(request.amountBaseUnits, "amountBaseUnits");
  parsePositiveBaseUnits(request.incidentLimitBaseUnits, "incidentLimitBaseUnits");
  parsePositiveBaseUnits(request.dailyLimitBaseUnits, "dailyLimitBaseUnits");
  validateTimestamp(request.occurredAt, "occurredAt");
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

function validateJsonValue(value: unknown, field: string): JsonValue {
  try {
    canonicalHash(value);
  } catch (error) {
    throw new TypeError(`${field} must be canonicalizable JSON`, { cause: error });
  }
  return clone(value) as JsonValue;
}

function parseChallenge(value: unknown): AuthoritativeChallengeRecord {
  if (!isPlainRecord(value)) throw new FirestoreDataIntegrityError("challenge must be an object");
  assertExactKeys(
    value,
    ["challengeId", "challengeHash", "paymentId", "operationId", "expiresAt", "capturedAt", "payload"],
    "challenge",
  );
  const record: AuthoritativeChallengeRecord = {
    challengeId: requireString(value, "challengeId"),
    challengeHash: requireString(value, "challengeHash") as `sha256:${string}`,
    paymentId: requireString(value, "paymentId"),
    operationId: requireString(value, "operationId"),
    expiresAt: requireString(value, "expiresAt"),
    capturedAt: requireString(value, "capturedAt"),
    payload: validateJsonValue(value.payload, "challenge.payload"),
  };
  validateIdentifier(record.challengeId, "challengeId");
  validateIdentifier(record.paymentId, "paymentId");
  validateIdentifier(record.operationId, "operationId");
  validateTimestamp(record.expiresAt, "expiresAt");
  validateTimestamp(record.capturedAt, "capturedAt");
  if (!Sha256Schema.safeParse(record.challengeHash).success || canonicalHash(record.payload) !== record.challengeHash) {
    throw new FirestoreDataIntegrityError("challengeHash does not bind the canonical challenge payload");
  }
  return record;
}

function parseReservation(value: unknown): ReservationRecord {
  if (!isPlainRecord(value)) throw new FirestoreDataIntegrityError("reservation must be an object");
  assertExactKeys(
    value,
    [
      "reservationId", "incidentId", "mandateId", "paymentId", "nonce", "idempotencyKey",
      "requestFingerprint", "amountBaseUnits", "budgetDay", "state", "version", "createdAt", "updatedAt",
      "stateHistory", "txSignature", "fulfillmentReceiptHash", "failureReason",
    ],
    "reservation",
  );
  const state = requireString(value, "state") as ReservationState;
  if (!RESERVATION_STATE_VALUES.includes(state)) throw new FirestoreDataIntegrityError("Invalid reservation state");
  if (!Array.isArray(value.stateHistory)) throw new FirestoreDataIntegrityError("stateHistory must be an array");
  const stateHistory = value.stateHistory.map((entry) => {
    if (!isPlainRecord(entry)) throw new FirestoreDataIntegrityError("Invalid reservation state event");
    assertExactKeys(entry, ["state", "at", "note"], "reservation state event");
    const eventState = requireString(entry, "state") as ReservationState;
    const at = requireString(entry, "at");
    if (!RESERVATION_STATE_VALUES.includes(eventState)) throw new FirestoreDataIntegrityError("Invalid state event state");
    validateTimestamp(at, "stateHistory.at");
    const note = entry.note;
    if (note !== undefined && typeof note !== "string") throw new FirestoreDataIntegrityError("state event note is invalid");
    return { state: eventState, at, ...(note === undefined ? {} : { note }) };
  });
  const record: ReservationRecord = {
    reservationId: requireString(value, "reservationId"),
    incidentId: requireString(value, "incidentId"),
    mandateId: requireString(value, "mandateId"),
    paymentId: requireString(value, "paymentId"),
    nonce: requireString(value, "nonce"),
    idempotencyKey: requireString(value, "idempotencyKey"),
    requestFingerprint: requireString(value, "requestFingerprint"),
    amountBaseUnits: requireString(value, "amountBaseUnits"),
    budgetDay: requireString(value, "budgetDay"),
    state,
    version: requireNumber(value, "version"),
    createdAt: requireString(value, "createdAt"),
    updatedAt: requireString(value, "updatedAt"),
    stateHistory,
    ...(typeof value.txSignature === "string" ? { txSignature: value.txSignature } : {}),
    ...(typeof value.fulfillmentReceiptHash === "string" ? { fulfillmentReceiptHash: value.fulfillmentReceiptHash } : {}),
    ...(typeof value.failureReason === "string" ? { failureReason: value.failureReason } : {}),
  };
  validateReserveRequest({
    reservationId: record.reservationId,
    incidentId: record.incidentId,
    mandateId: record.mandateId,
    paymentId: record.paymentId,
    nonce: record.nonce,
    idempotencyKey: record.idempotencyKey,
    requestFingerprint: record.requestFingerprint,
    amountBaseUnits: record.amountBaseUnits,
    incidentLimitBaseUnits: record.amountBaseUnits,
    dailyLimitBaseUnits: record.amountBaseUnits,
    occurredAt: record.createdAt,
  });
  validateTimestamp(record.updatedAt, "updatedAt");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.budgetDay) || record.version < 1 || stateHistory.length < 2) {
    throw new FirestoreDataIntegrityError("Invalid reservation metadata");
  }
  if (record.fulfillmentReceiptHash && !Sha256Schema.safeParse(record.fulfillmentReceiptHash).success) {
    throw new FirestoreDataIntegrityError("Invalid fulfillmentReceiptHash");
  }
  return record;
}

function parseIdentifierBinding(value: unknown): IdentifierBindingRecord {
  if (!isPlainRecord(value)) throw new FirestoreDataIntegrityError("identifier binding must be an object");
  assertExactKeys(value, ["kind", "value", "reservationId", "requestFingerprint", "createdAt"], "identifier binding");
  const kind = requireString(value, "kind") as IdentifierBindingRecord["kind"];
  if (!(["paymentId", "nonce", "idempotencyKey"] as const).includes(kind)) {
    throw new FirestoreDataIntegrityError("Invalid identifier binding kind");
  }
  const record: IdentifierBindingRecord = {
    kind,
    value: requireString(value, "value"),
    reservationId: requireString(value, "reservationId"),
    requestFingerprint: requireString(value, "requestFingerprint"),
    createdAt: requireString(value, "createdAt"),
  };
  validateIdentifier(record.value, `identifier.${kind}`);
  validateIdentifier(record.reservationId, "identifier.reservationId");
  if (!Sha256Schema.safeParse(record.requestFingerprint).success) throw new FirestoreDataIntegrityError("Invalid identifier fingerprint");
  validateTimestamp(record.createdAt, "identifier.createdAt");
  return record;
}

function parseBudgetCounter(value: unknown): BudgetCounterRecord {
  if (!isPlainRecord(value)) throw new FirestoreDataIntegrityError("budget counter must be an object");
  assertExactKeys(value, ["scope", "mandateId", "incidentId", "budgetDay", "heldBaseUnits", "version", "updatedAt"], "budget counter");
  const scope = requireString(value, "scope") as BudgetCounterRecord["scope"];
  if (scope !== "incident" && scope !== "daily") throw new FirestoreDataIntegrityError("Invalid budget scope");
  const record: BudgetCounterRecord = {
    scope,
    mandateId: requireString(value, "mandateId"),
    heldBaseUnits: requireString(value, "heldBaseUnits"),
    version: requireNumber(value, "version"),
    updatedAt: requireString(value, "updatedAt"),
    ...(typeof value.incidentId === "string" ? { incidentId: value.incidentId } : {}),
    ...(typeof value.budgetDay === "string" ? { budgetDay: value.budgetDay } : {}),
  };
  validateIdentifier(record.mandateId, "counter.mandateId");
  parseBaseUnits(record.heldBaseUnits, "counter.heldBaseUnits");
  validateTimestamp(record.updatedAt, "counter.updatedAt");
  if (record.version < 1 || (scope === "incident") !== (record.incidentId !== undefined) || (scope === "daily") !== (record.budgetDay !== undefined)) {
    throw new FirestoreDataIntegrityError("Invalid budget counter metadata");
  }
  return record;
}

function parseVendorClaim(value: unknown): VendorPaymentClaimRecord {
  if (!isPlainRecord(value)) throw new FirestoreDataIntegrityError("vendor claim must be an object");
  assertExactKeys(
    value,
    [
      "vendorTenant", "paymentId", "requestFingerprint", "state", "version", "settlementAttempted",
      "createdAt", "updatedAt", "txSignature", "resourceResponseHash", "resourceContentType",
      "resourceBodyBase64", "fulfillmentReceipt",
    ],
    "vendor claim",
  );
  const state = requireString(value, "state") as VendorClaimState;
  if (!VENDOR_CLAIM_STATE_VALUES.includes(state)) throw new FirestoreDataIntegrityError("Invalid vendor claim state");
  const receipt = value.fulfillmentReceipt === undefined
    ? undefined
    : validateJsonValue(value.fulfillmentReceipt, "fulfillmentReceipt");
  const record: VendorPaymentClaimRecord = {
    vendorTenant: requireString(value, "vendorTenant"),
    paymentId: requireString(value, "paymentId"),
    requestFingerprint: requireString(value, "requestFingerprint"),
    state,
    version: requireNumber(value, "version"),
    settlementAttempted: requireBoolean(value, "settlementAttempted"),
    createdAt: requireString(value, "createdAt"),
    updatedAt: requireString(value, "updatedAt"),
    ...(typeof value.txSignature === "string" ? { txSignature: value.txSignature } : {}),
    ...(typeof value.resourceResponseHash === "string" ? { resourceResponseHash: value.resourceResponseHash } : {}),
    ...(typeof value.resourceContentType === "string" ? { resourceContentType: value.resourceContentType } : {}),
    ...(typeof value.resourceBodyBase64 === "string" ? { resourceBodyBase64: value.resourceBodyBase64 } : {}),
    ...(receipt === undefined ? {} : { fulfillmentReceipt: receipt }),
  };
  validateIdentifier(record.vendorTenant, "vendorTenant");
  validateIdentifier(record.paymentId, "paymentId");
  if (!Sha256Schema.safeParse(record.requestFingerprint).success) throw new FirestoreDataIntegrityError("Invalid vendor fingerprint");
  validateTimestamp(record.createdAt, "vendor.createdAt");
  validateTimestamp(record.updatedAt, "vendor.updatedAt");
  if (record.version < 1) throw new FirestoreDataIntegrityError("Invalid vendor claim version");
  if (record.resourceResponseHash && !Sha256Schema.safeParse(record.resourceResponseHash).success) {
    throw new FirestoreDataIntegrityError("Invalid resourceResponseHash");
  }
  return record;
}

function validateDenial(record: DenialRecord): DenialRecord {
  validateIdentifier(record.denialId, "denialId");
  validateIdentifier(record.incidentId, "incidentId");
  validateIdentifier(record.mandateId, "mandateId");
  if (!Sha256Schema.safeParse(record.requestFingerprint).success) throw new TypeError("requestFingerprint is invalid");
  parsePositiveBaseUnits(record.attemptedAmountBaseUnits, "attemptedAmountBaseUnits");
  validateTimestamp(record.attemptedAt, "attemptedAt");
  if (typeof record.reasonCode !== "string" || record.reasonCode.length === 0) throw new TypeError("reasonCode is invalid");
  if (record.transactionCreated !== false || record.txSignature !== null) {
    throw new TypeError("Denial records cannot contain a transaction");
  }
  return clone(record);
}

function parseDenial(value: unknown): DenialRecord {
  if (!isPlainRecord(value)) throw new FirestoreDataIntegrityError("denial must be an object");
  assertExactKeys(
    value,
    [
      "denialId", "incidentId", "mandateId", "requestFingerprint", "reasonCode",
      "attemptedAmountBaseUnits", "attemptedAt", "transactionCreated", "txSignature",
    ],
    "denial",
  );
  if (value.transactionCreated !== false || value.txSignature !== null) {
    throw new FirestoreDataIntegrityError("Stored denial contains a transaction");
  }
  return validateDenial({
    denialId: requireString(value, "denialId"),
    incidentId: requireString(value, "incidentId"),
    mandateId: requireString(value, "mandateId"),
    requestFingerprint: requireString(value, "requestFingerprint"),
    reasonCode: requireString(value, "reasonCode"),
    attemptedAmountBaseUnits: requireString(value, "attemptedAmountBaseUnits"),
    attemptedAt: requireString(value, "attemptedAt"),
    transactionCreated: false,
    txSignature: null,
  });
}

function validateAuditEventInput(input: AuditEventInput): AuditEventInput {
  validateIdentifier(input.eventId, "eventId");
  validateIdentifier(input.type, "event.type");
  validateTimestamp(input.occurredAt, "event.occurredAt");
  for (const [field, value] of Object.entries({
    correlationId: input.correlationId,
    incidentId: input.incidentId,
    mandateId: input.mandateId,
    paymentId: input.paymentId,
    idempotencyKey: input.idempotencyKey,
  })) {
    if (value !== undefined) validateIdentifier(value, field);
  }
  if (input.txSignature !== undefined && (typeof input.txSignature !== "string" || input.txSignature.length === 0)) {
    throw new TypeError("event.txSignature is invalid");
  }
  return { ...input, payload: validateJsonValue(input.payload, "event.payload") };
}

function makeAuditEvent(input: AuditEventInput): AuditEventRecord {
  const validated = validateAuditEventInput(input);
  return { ...validated, eventHash: canonicalHash(validated) };
}

function parseAuditEvent(value: unknown): AuditEventRecord {
  if (!isPlainRecord(value)) throw new FirestoreDataIntegrityError("audit event must be an object");
  assertExactKeys(
    value,
    [
      "eventId", "type", "occurredAt", "incidentId", "mandateId", "paymentId",
      "correlationId", "idempotencyKey", "txSignature", "payload", "eventHash",
    ],
    "audit event",
  );
  const input: AuditEventInput = {
    eventId: requireString(value, "eventId"),
    type: requireString(value, "type"),
    occurredAt: requireString(value, "occurredAt"),
    payload: validateJsonValue(value.payload, "event.payload"),
    ...(typeof value.correlationId === "string" ? { correlationId: value.correlationId } : {}),
    ...(typeof value.incidentId === "string" ? { incidentId: value.incidentId } : {}),
    ...(typeof value.mandateId === "string" ? { mandateId: value.mandateId } : {}),
    ...(typeof value.paymentId === "string" ? { paymentId: value.paymentId } : {}),
    ...(typeof value.idempotencyKey === "string" ? { idempotencyKey: value.idempotencyKey } : {}),
    ...(typeof value.txSignature === "string" ? { txSignature: value.txSignature } : {}),
  };
  const event = makeAuditEvent(input);
  if (value.eventHash !== event.eventHash) throw new FirestoreDataIntegrityError("Audit event hash mismatch");
  return event;
}

function deterministicEventId(type: string, identity: JsonValue): string {
  return `evt_${canonicalHash({ type, identity }).slice("sha256:".length, "sha256:".length + 40)}`;
}

function makeCounter(
  scope: "incident" | "daily",
  mandateId: string,
  dimension: string,
  heldBaseUnits: bigint,
  version: number,
  occurredAt: string,
): BudgetCounterRecord {
  return {
    scope,
    mandateId,
    heldBaseUnits: heldBaseUnits.toString(),
    version,
    updatedAt: occurredAt,
    ...(scope === "incident" ? { incidentId: dimension } : { budgetDay: dimension }),
  };
}

function assertCounterIdentity(
  counter: BudgetCounterRecord,
  scope: "incident" | "daily",
  mandateId: string,
  dimension: string,
): void {
  const matches =
    counter.scope === scope &&
    counter.mandateId === mandateId &&
    (scope === "incident" ? counter.incidentId === dimension : counter.budgetDay === dimension);
  if (!matches) throw new FirestoreDataIntegrityError("Budget counter identity mismatch");
}

export class FirestoreTransactionalRepository
  implements TransactionalPersistence, ReservationRepository, VendorClaimRepository, AuthoritativeRecordRepository, AuditEventRepository
{
  readonly firestore: Firestore;
  readonly collectionPrefix: string;
  readonly transactionMaxAttempts: number;

  constructor(firestore: Firestore, options: FirestorePersistenceOptions = {}) {
    const collectionPrefix = options.collectionPrefix ?? "uptime402";
    validateCollectionPrefix(collectionPrefix);
    const transactionMaxAttempts = options.transactionMaxAttempts ?? 5;
    if (!Number.isInteger(transactionMaxAttempts) || transactionMaxAttempts < 1 || transactionMaxAttempts > 10) {
      throw new TypeError("transactionMaxAttempts must be an integer from 1 through 10");
    }
    this.firestore = firestore;
    this.collectionPrefix = collectionPrefix;
    this.transactionMaxAttempts = transactionMaxAttempts;
  }

  private collectionName(suffix: string): string {
    return `${this.collectionPrefix}_${suffix}`;
  }

  private document(suffix: string, id: string): DocumentReference {
    return this.firestore.collection(this.collectionName(suffix)).doc(id);
  }

  private identifierDocument(kind: IdentifierBindingRecord["kind"], value: string): DocumentReference {
    return this.document("reservation_identifiers", hashDocumentId(kind, [value]));
  }

  private incidentCounterDocument(mandateId: string, incidentId: string): DocumentReference {
    return this.document("budget_counters", hashDocumentId("incident", [mandateId, incidentId]));
  }

  private dailyCounterDocument(mandateId: string, day: string): DocumentReference {
    return this.document("budget_counters", hashDocumentId("daily", [mandateId, day]));
  }

  private vendorClaimDocument(vendorTenant: string, paymentId: string): DocumentReference {
    return this.document("vendor_claims", hashDocumentId("vendor-claim", [vendorTenant, paymentId]));
  }

  private auditEventDocument(eventId: string): DocumentReference {
    return this.document("audit_events", eventId);
  }

  private writeAuditEvent(transaction: Transaction, event: AuditEventRecord): void {
    transaction.create(this.auditEventDocument(event.eventId), makeEnvelope(event));
  }

  private async putImmutable<T>(
    suffix: string,
    id: string,
    value: T,
    parser: (input: unknown) => T,
  ): Promise<ImmutablePutResult<T>> {
    validateIdentifier(id, `${suffix}.id`);
    const parsed = parser(value);
    const reference = this.document(suffix, id);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const existing = parseEnvelope(snapshot, parser);
      if (existing) {
        if (canonicalHash(existing) !== canonicalHash(parsed)) {
          throw new ImmutableRecordConflictError(this.collectionName(suffix), id);
        }
        return { kind: "existing", record: clone(existing) };
      }
      transaction.create(reference, makeEnvelope(parsed));
      return { kind: "stored", record: clone(parsed) };
    }, { maxAttempts: this.transactionMaxAttempts });
  }

  private async getImmutable<T>(suffix: string, id: string, parser: (input: unknown) => T): Promise<T | null> {
    validateIdentifier(id, `${suffix}.id`);
    const record = parseEnvelope(await this.document(suffix, id).get(), parser);
    return record ? clone(record) : null;
  }

  async putMandate(record: Mandate): Promise<ImmutablePutResult<Mandate>> {
    const parsed = MandateSchema.parse(record);
    if (computeMandateHash(parsed) !== parsed.mandateHash) throw new TypeError("mandateHash is invalid");
    return this.putImmutable("mandates", parsed.id, parsed, (value) => {
      const stored = MandateSchema.parse(value);
      if (computeMandateHash(stored) !== stored.mandateHash) throw new FirestoreDataIntegrityError("Stored mandateHash is invalid");
      return stored;
    });
  }

  async getMandate(mandateId: string): Promise<Mandate | null> {
    return this.getImmutable("mandates", mandateId, (value) => {
      const stored = MandateSchema.parse(value);
      if (computeMandateHash(stored) !== stored.mandateHash) throw new FirestoreDataIntegrityError("Stored mandateHash is invalid");
      return stored;
    });
  }

  async putExecutionPolicy(record: ExecutionPolicy): Promise<ImmutablePutResult<ExecutionPolicy>> {
    const parsed = ExecutionPolicySchema.parse(record);
    if (computeExecutionPolicyHash(parsed) !== parsed.policyHash) throw new TypeError("policyHash is invalid");
    return this.putImmutable("execution_policies", parsed.id, parsed, (value) => {
      const stored = ExecutionPolicySchema.parse(value);
      if (computeExecutionPolicyHash(stored) !== stored.policyHash) throw new FirestoreDataIntegrityError("Stored policyHash is invalid");
      return stored;
    });
  }

  async getExecutionPolicy(policyId: string): Promise<ExecutionPolicy | null> {
    return this.getImmutable("execution_policies", policyId, (value) => {
      const stored = ExecutionPolicySchema.parse(value);
      if (computeExecutionPolicyHash(stored) !== stored.policyHash) throw new FirestoreDataIntegrityError("Stored policyHash is invalid");
      return stored;
    });
  }

  async putOffer(record: VendorOffer): Promise<ImmutablePutResult<VendorOffer>> {
    const parsed = VendorOfferSchema.parse(record);
    return this.putImmutable("offers", parsed.payload.offerId, parsed, (value) =>
      VendorOfferSchema.parse(value),
    );
  }

  async getOffer(offerId: string): Promise<VendorOffer | null> {
    return this.getImmutable("offers", offerId, (value) => VendorOfferSchema.parse(value));
  }

  async putChallenge(record: AuthoritativeChallengeRecord): Promise<ImmutablePutResult<AuthoritativeChallengeRecord>> {
    const parsed = parseChallenge(record);
    return this.putImmutable("challenges", parsed.challengeId, parsed, parseChallenge);
  }

  async getChallenge(challengeId: string): Promise<AuthoritativeChallengeRecord | null> {
    return this.getImmutable("challenges", challengeId, parseChallenge);
  }

  async loadAuthoritativePaymentContext(ids: {
    mandateId: string;
    executionPolicyId: string;
    offerId: string;
    challengeId: string;
  }): Promise<AuthoritativePaymentContext> {
    validateIdentifier(ids.mandateId, "mandateId");
    validateIdentifier(ids.executionPolicyId, "executionPolicyId");
    validateIdentifier(ids.offerId, "offerId");
    validateIdentifier(ids.challengeId, "challengeId");
    const references = [
      this.document("mandates", ids.mandateId),
      this.document("execution_policies", ids.executionPolicyId),
      this.document("offers", ids.offerId),
      this.document("challenges", ids.challengeId),
    ] as const;
    return this.firestore.runTransaction(async (transaction) => {
      const snapshots = await transaction.getAll(...references);
      const mandate = parseEnvelope(snapshots[0]!, (value) => MandateSchema.parse(value));
      const executionPolicy = parseEnvelope(snapshots[1]!, (value) => ExecutionPolicySchema.parse(value));
      const offer = parseEnvelope(snapshots[2]!, (value) => VendorOfferSchema.parse(value));
      const challenge = parseEnvelope(snapshots[3]!, parseChallenge);
      if (!mandate || !executionPolicy || !offer || !challenge) {
        throw new FirestoreDataIntegrityError("Authoritative payment context is incomplete");
      }
      if (
        computeMandateHash(mandate) !== mandate.mandateHash ||
        computeExecutionPolicyHash(executionPolicy) !== executionPolicy.policyHash ||
        mandate.executionPolicyHash !== executionPolicy.policyHash
      ) {
        throw new FirestoreDataIntegrityError("Authoritative payment context hash binding failed");
      }
      return { mandate, executionPolicy, offer, challenge };
    }, { readOnly: true });
  }

  async reserveBudget(request: ReserveBudgetRequest): Promise<ReserveBudgetResult> {
    validateReserveRequest(request);
    const reservationReference = this.document("reservations", request.reservationId);
    const paymentIdReference = this.identifierDocument("paymentId", request.paymentId);
    const nonceReference = this.identifierDocument("nonce", request.nonce);
    const idempotencyReference = this.identifierDocument("idempotencyKey", request.idempotencyKey);
    const day = budgetDay(request.occurredAt);
    const incidentCounterReference = this.incidentCounterDocument(request.mandateId, request.incidentId);
    const dailyCounterReference = this.dailyCounterDocument(request.mandateId, day);

    return this.firestore.runTransaction(async (transaction) => {
      const snapshots = await transaction.getAll(
        reservationReference,
        paymentIdReference,
        nonceReference,
        idempotencyReference,
        incidentCounterReference,
        dailyCounterReference,
      );
      const directRecord = parseEnvelope(snapshots[0]!, parseReservation);
      const paymentBinding = parseEnvelope(snapshots[1]!, parseIdentifierBinding);
      const nonceBinding = parseEnvelope(snapshots[2]!, parseIdentifierBinding);
      const idempotencyBinding = parseEnvelope(snapshots[3]!, parseIdentifierBinding);
      const bindings = [paymentBinding, nonceBinding, idempotencyBinding];
      const boundIds = new Set(
        bindings.filter((binding): binding is IdentifierBindingRecord => binding !== null).map(({ reservationId }) => reservationId),
      );

      if (
        directRecord &&
        sameReservationRequest(directRecord, request) &&
        bindings.every((binding) => binding?.reservationId === directRecord.reservationId)
      ) {
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
        const conflictReason = paymentBinding
          ? "payment_id"
          : nonceBinding
            ? "nonce"
            : "idempotency_key";
        return { kind: "conflict", reason: conflictReason, existingReservationId };
      }

      const storedIncidentCounter = parseEnvelope(snapshots[4]!, parseBudgetCounter);
      const storedDailyCounter = parseEnvelope(snapshots[5]!, parseBudgetCounter);
      if (storedIncidentCounter) assertCounterIdentity(storedIncidentCounter, "incident", request.mandateId, request.incidentId);
      if (storedDailyCounter) assertCounterIdentity(storedDailyCounter, "daily", request.mandateId, day);

      const incidentUsed = storedIncidentCounter
        ? parseBaseUnits(storedIncidentCounter.heldBaseUnits, "incident heldBaseUnits")
        : 0n;
      const dailyUsed = storedDailyCounter
        ? parseBaseUnits(storedDailyCounter.heldBaseUnits, "daily heldBaseUnits")
        : 0n;
      const amount = parsePositiveBaseUnits(request.amountBaseUnits, "amountBaseUnits");
      const incidentLimit = parsePositiveBaseUnits(request.incidentLimitBaseUnits, "incidentLimitBaseUnits");
      const dailyLimit = parsePositiveBaseUnits(request.dailyLimitBaseUnits, "dailyLimitBaseUnits");

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
      const identifierRecords: readonly [IdentifierBindingRecord, IdentifierBindingRecord, IdentifierBindingRecord] = [
        {
          kind: "paymentId",
          value: request.paymentId,
          reservationId: request.reservationId,
          requestFingerprint: request.requestFingerprint,
          createdAt: request.occurredAt,
        },
        {
          kind: "nonce",
          value: request.nonce,
          reservationId: request.reservationId,
          requestFingerprint: request.requestFingerprint,
          createdAt: request.occurredAt,
        },
        {
          kind: "idempotencyKey",
          value: request.idempotencyKey,
          reservationId: request.reservationId,
          requestFingerprint: request.requestFingerprint,
          createdAt: request.occurredAt,
        },
      ];

      transaction.create(reservationReference, makeEnvelope(record));
      transaction.create(paymentIdReference, makeEnvelope(identifierRecords[0]));
      transaction.create(nonceReference, makeEnvelope(identifierRecords[1]));
      transaction.create(idempotencyReference, makeEnvelope(identifierRecords[2]));
      transaction.set(
        incidentCounterReference,
        makeEnvelope(makeCounter(
          "incident",
          request.mandateId,
          request.incidentId,
          incidentUsed + amount,
          (storedIncidentCounter?.version ?? 0) + 1,
          request.occurredAt,
        )),
      );
      transaction.set(
        dailyCounterReference,
        makeEnvelope(makeCounter(
          "daily",
          request.mandateId,
          day,
          dailyUsed + amount,
          (storedDailyCounter?.version ?? 0) + 1,
          request.occurredAt,
        )),
      );
      this.writeAuditEvent(transaction, makeAuditEvent({
        eventId: deterministicEventId("reservation.reserved", { reservationId: record.reservationId, version: record.version }),
        type: "reservation.reserved",
        occurredAt: request.occurredAt,
        incidentId: request.incidentId,
        mandateId: request.mandateId,
        paymentId: request.paymentId,
        idempotencyKey: request.idempotencyKey,
        payload: {
          reservationId: record.reservationId,
          requestFingerprint: record.requestFingerprint,
          amountBaseUnits: record.amountBaseUnits,
          transactionCreated: false,
        },
      }));
      return { kind: "reserved", record: clone(record) };
    }, { maxAttempts: this.transactionMaxAttempts });
  }

  async getReservation(reservationId: string): Promise<ReservationRecord | null> {
    validateIdentifier(reservationId, "reservationId");
    const record = parseEnvelope(await this.document("reservations", reservationId).get(), parseReservation);
    return record ? clone(record) : null;
  }

  private async getReservationByIdentifier(
    kind: IdentifierBindingRecord["kind"],
    value: string,
  ): Promise<ReservationRecord | null> {
    validateIdentifier(value, kind);
    const identifierReference = this.identifierDocument(kind, value);
    return this.firestore.runTransaction(async (transaction) => {
      const binding = parseEnvelope(await transaction.get(identifierReference), parseIdentifierBinding);
      if (!binding) return null;
      if (binding.kind !== kind || binding.value !== value) {
        throw new FirestoreDataIntegrityError(`${kind} identifier binding mismatch`);
      }
      const reservation = parseEnvelope(
        await transaction.get(this.document("reservations", binding.reservationId)),
        parseReservation,
      );
      const reservationIdentifier =
        kind === "paymentId"
          ? reservation?.paymentId
          : kind === "nonce"
            ? reservation?.nonce
            : reservation?.idempotencyKey;
      if (!reservation || reservationIdentifier !== value || reservation.requestFingerprint !== binding.requestFingerprint) {
        throw new FirestoreDataIntegrityError(`${kind} identifier points to an invalid reservation`);
      }
      return clone(reservation);
    }, { readOnly: true });
  }

  async getReservationByPaymentId(paymentId: string): Promise<ReservationRecord | null> {
    return this.getReservationByIdentifier("paymentId", paymentId);
  }

  async getReservationByNonce(nonce: string): Promise<ReservationRecord | null> {
    return this.getReservationByIdentifier("nonce", nonce);
  }

  async getReservationByIdempotencyKey(idempotencyKey: string): Promise<ReservationRecord | null> {
    return this.getReservationByIdentifier("idempotencyKey", idempotencyKey);
  }

  async transitionReservation(
    reservationId: string,
    expectedStates: readonly ReservationState[],
    nextState: ReservationState,
    occurredAt: string,
    patch: ReservationTransitionPatch = {},
  ): Promise<ReservationRecord> {
    validateIdentifier(reservationId, "reservationId");
    validateTimestamp(occurredAt, "occurredAt");
    if (expectedStates.length === 0 || expectedStates.some((state) => !RESERVATION_STATE_VALUES.includes(state))) {
      throw new TypeError("expectedStates contains an invalid reservation state");
    }
    if (!RESERVATION_STATE_VALUES.includes(nextState)) throw new TypeError("nextState is invalid");
    const reservationReference = this.document("reservations", reservationId);

    return this.firestore.runTransaction(async (transaction) => {
      const record = parseEnvelope(await transaction.get(reservationReference), parseReservation);
      if (!record) throw new Error(`Reservation not found: ${reservationId}`);
      if (!expectedStates.includes(record.state)) {
        throw new Error(`Reservation ${reservationId} is ${record.state}, expected ${expectedStates.join(" or ")}`);
      }
      if (!ALLOWED_RESERVATION_TRANSITIONS[record.state].includes(nextState)) {
        throw new Error(`Illegal reservation transition ${record.state} -> ${nextState}`);
      }
      if (
        (nextState === "confirmed" || nextState === "fulfilled" || nextState === "committed") &&
        !(patch.txSignature ?? record.txSignature)
      ) {
        throw new Error(`${nextState} requires a transaction signature`);
      }
      if (
        (nextState === "fulfilled" || nextState === "committed") &&
        !(patch.fulfillmentReceiptHash ?? record.fulfillmentReceiptHash)
      ) {
        throw new Error(`${nextState} requires a fulfillment receipt hash`);
      }

      const leavingBudgetHold = BUDGET_HOLDING_STATES.has(record.state) && !BUDGET_HOLDING_STATES.has(nextState);
      let incidentCounter: BudgetCounterRecord | null = null;
      let dailyCounter: BudgetCounterRecord | null = null;
      const incidentCounterReference = this.incidentCounterDocument(record.mandateId, record.incidentId);
      const dailyCounterReference = this.dailyCounterDocument(record.mandateId, record.budgetDay);
      if (leavingBudgetHold) {
        const counterSnapshots = await transaction.getAll(incidentCounterReference, dailyCounterReference);
        incidentCounter = parseEnvelope(counterSnapshots[0]!, parseBudgetCounter);
        dailyCounter = parseEnvelope(counterSnapshots[1]!, parseBudgetCounter);
        if (!incidentCounter || !dailyCounter) throw new FirestoreDataIntegrityError("Budget counter is missing");
        assertCounterIdentity(incidentCounter, "incident", record.mandateId, record.incidentId);
        assertCounterIdentity(dailyCounter, "daily", record.mandateId, record.budgetDay);
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
      transaction.set(reservationReference, makeEnvelope(updated));

      if (leavingBudgetHold) {
        const amount = BigInt(record.amountBaseUnits);
        const incidentHeld = parseBaseUnits(incidentCounter!.heldBaseUnits, "incident heldBaseUnits");
        const dailyHeld = parseBaseUnits(dailyCounter!.heldBaseUnits, "daily heldBaseUnits");
        if (incidentHeld < amount || dailyHeld < amount) throw new FirestoreDataIntegrityError("Budget counter underflow");
        transaction.set(
          incidentCounterReference,
          makeEnvelope(makeCounter(
            "incident",
            record.mandateId,
            record.incidentId,
            incidentHeld - amount,
            incidentCounter!.version + 1,
            occurredAt,
          )),
        );
        transaction.set(
          dailyCounterReference,
          makeEnvelope(makeCounter(
            "daily",
            record.mandateId,
            record.budgetDay,
            dailyHeld - amount,
            dailyCounter!.version + 1,
            occurredAt,
          )),
        );
      }

      this.writeAuditEvent(transaction, makeAuditEvent({
        eventId: deterministicEventId("reservation.transition", { reservationId, version: updated.version }),
        type: "reservation.transition",
        occurredAt,
        incidentId: updated.incidentId,
        mandateId: updated.mandateId,
        paymentId: updated.paymentId,
        idempotencyKey: updated.idempotencyKey,
        ...(updated.txSignature ? { txSignature: updated.txSignature } : {}),
        payload: {
          reservationId,
          previousState: record.state,
          nextState,
          requestFingerprint: updated.requestFingerprint,
        },
      }));
      return clone(updated);
    }, { maxAttempts: this.transactionMaxAttempts });
  }

  async getBudgetUsage(mandateId: string, incidentId: string, occurredAt: string): Promise<BudgetUsage> {
    validateIdentifier(mandateId, "mandateId");
    validateIdentifier(incidentId, "incidentId");
    const day = budgetDay(occurredAt);
    const incidentReference = this.incidentCounterDocument(mandateId, incidentId);
    const dailyReference = this.dailyCounterDocument(mandateId, day);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshots = await transaction.getAll(incidentReference, dailyReference);
      const incident = parseEnvelope(snapshots[0]!, parseBudgetCounter);
      const daily = parseEnvelope(snapshots[1]!, parseBudgetCounter);
      if (incident) assertCounterIdentity(incident, "incident", mandateId, incidentId);
      if (daily) assertCounterIdentity(daily, "daily", mandateId, day);
      return {
        incidentCommittedAndReservedBaseUnits: incident?.heldBaseUnits ?? "0",
        dailyCommittedAndReservedBaseUnits: daily?.heldBaseUnits ?? "0",
      };
    }, { readOnly: true });
  }

  async recordDenial(record: DenialRecord): Promise<void> {
    const validated = validateDenial(record);
    const reference = this.document("denials", validated.denialId);
    await this.firestore.runTransaction(async (transaction) => {
      const existing = parseEnvelope(await transaction.get(reference), parseDenial);
      if (existing) {
        if (canonicalHash(existing) !== canonicalHash(validated)) {
          throw new ImmutableRecordConflictError(this.collectionName("denials"), validated.denialId);
        }
        return;
      }
      transaction.create(reference, makeEnvelope(validated));
      this.writeAuditEvent(transaction, makeAuditEvent({
        eventId: deterministicEventId("policy.denied", { denialId: validated.denialId }),
        type: "policy.denied",
        occurredAt: validated.attemptedAt,
        incidentId: validated.incidentId,
        mandateId: validated.mandateId,
        payload: {
          denialId: validated.denialId,
          reasonCode: validated.reasonCode,
          requestFingerprint: validated.requestFingerprint,
          attemptedAmountBaseUnits: validated.attemptedAmountBaseUnits,
          transactionCreated: false,
          txSignature: null,
        },
      }));
    }, { maxAttempts: this.transactionMaxAttempts });
  }

  async listDenials(): Promise<DenialRecord[]> {
    const snapshot = await this.firestore.collection(this.collectionName("denials")).get();
    return snapshot.docs
      .map((document) => parseEnvelope(document, parseDenial))
      .filter((record): record is DenialRecord => record !== null)
      .sort((left, right) => left.attemptedAt.localeCompare(right.attemptedAt));
  }

  async recordAuditEvent(event: AuditEventInput): Promise<ImmutablePutResult<AuditEventRecord>> {
    const record = makeAuditEvent(event);
    const reference = this.auditEventDocument(record.eventId);
    return this.firestore.runTransaction(async (transaction) => {
      const existing = parseEnvelope(await transaction.get(reference), parseAuditEvent);
      if (existing) {
        if (canonicalHash(existing) !== canonicalHash(record)) {
          throw new ImmutableRecordConflictError(this.collectionName("audit_events"), record.eventId);
        }
        return { kind: "existing", record: clone(existing) };
      }
      transaction.create(reference, makeEnvelope(record));
      return { kind: "stored", record: clone(record) };
    }, { maxAttempts: this.transactionMaxAttempts });
  }

  async listAuditEvents(limit = 200): Promise<AuditEventRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError("limit must be from 1 through 1000");
    const snapshot = await this.firestore.collection(this.collectionName("audit_events")).get();
    return snapshot.docs
      .map((document) => parseEnvelope(document, parseAuditEvent))
      .filter((record): record is AuditEventRecord => record !== null)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
      .slice(-limit);
  }

  async claimVendorPayment(request: ClaimVendorPaymentRequest): Promise<ClaimVendorPaymentResult> {
    validateIdentifier(request.vendorTenant, "vendorTenant");
    validateIdentifier(request.paymentId, "paymentId");
    if (!Sha256Schema.safeParse(request.requestFingerprint).success) throw new TypeError("requestFingerprint is invalid");
    validateTimestamp(request.occurredAt, "occurredAt");
    const reference = this.vendorClaimDocument(request.vendorTenant, request.paymentId);

    return this.firestore.runTransaction(async (transaction) => {
      const existing = parseEnvelope(await transaction.get(reference), parseVendorClaim);
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
        transaction.create(reference, makeEnvelope(record));
        this.writeAuditEvent(transaction, makeAuditEvent({
          eventId: deterministicEventId("vendor.claim.acquired", {
            vendorTenant: request.vendorTenant,
            paymentId: request.paymentId,
          }),
          type: "vendor.claim.acquired",
          occurredAt: request.occurredAt,
          paymentId: request.paymentId,
          payload: {
            vendorTenant: request.vendorTenant,
            requestFingerprint: request.requestFingerprint,
            state: "settling",
          },
        }));
        return { kind: "acquired", record: clone(record) };
      }
      if (
        existing.vendorTenant !== request.vendorTenant ||
        existing.paymentId !== request.paymentId
      ) {
        throw new FirestoreDataIntegrityError("Vendor claim document identity mismatch");
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
    }, { maxAttempts: this.transactionMaxAttempts });
  }

  async getVendorPaymentClaim(vendorTenant: string, paymentId: string): Promise<VendorPaymentClaimRecord | null> {
    validateIdentifier(vendorTenant, "vendorTenant");
    validateIdentifier(paymentId, "paymentId");
    const record = parseEnvelope(await this.vendorClaimDocument(vendorTenant, paymentId).get(), parseVendorClaim);
    if (record && (record.vendorTenant !== vendorTenant || record.paymentId !== paymentId)) {
      throw new FirestoreDataIntegrityError("Vendor claim document identity mismatch");
    }
    return record ? clone(record) : null;
  }

  async markVendorSettlementAttempted(
    vendorTenant: string,
    paymentId: string,
    expectedVersion: number,
    occurredAt: string,
  ): Promise<VendorPaymentClaimRecord> {
    validateIdentifier(vendorTenant, "vendorTenant");
    validateIdentifier(paymentId, "paymentId");
    validateTimestamp(occurredAt, "occurredAt");
    const reference = this.vendorClaimDocument(vendorTenant, paymentId);
    return this.firestore.runTransaction(async (transaction) => {
      const record = parseEnvelope(await transaction.get(reference), parseVendorClaim);
      if (!record) throw new Error(`Vendor claim not found: ${vendorTenant}/${paymentId}`);
      if (record.vendorTenant !== vendorTenant || record.paymentId !== paymentId) {
        throw new FirestoreDataIntegrityError("Vendor claim document identity mismatch");
      }
      if (record.state !== "settling" || record.version !== expectedVersion || record.settlementAttempted) {
        throw new Error("Vendor claim changed before settlement attempt");
      }
      const updated: VendorPaymentClaimRecord = {
        ...record,
        settlementAttempted: true,
        version: record.version + 1,
        updatedAt: occurredAt,
      };
      transaction.set(reference, makeEnvelope(updated));
      this.writeAuditEvent(transaction, makeAuditEvent({
        eventId: deterministicEventId("vendor.settlement.attempted", {
          vendorTenant,
          paymentId,
          version: updated.version,
        }),
        type: "vendor.settlement.attempted",
        occurredAt,
        paymentId,
        payload: {
          vendorTenant,
          requestFingerprint: updated.requestFingerprint,
          settlementAttempted: true,
        },
      }));
      return clone(updated);
    }, { maxAttempts: this.transactionMaxAttempts });
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
    validateIdentifier(vendorTenant, "vendorTenant");
    validateIdentifier(paymentId, "paymentId");
    validateTimestamp(occurredAt, "occurredAt");
    if (!VENDOR_CLAIM_STATE_VALUES.includes(expectedState) || !VENDOR_CLAIM_STATE_VALUES.includes(nextState)) {
      throw new TypeError("Invalid vendor claim state");
    }
    const reference = this.vendorClaimDocument(vendorTenant, paymentId);
    return this.firestore.runTransaction(async (transaction) => {
      const record = parseEnvelope(await transaction.get(reference), parseVendorClaim);
      if (!record) throw new Error(`Vendor claim not found: ${vendorTenant}/${paymentId}`);
      if (record.vendorTenant !== vendorTenant || record.paymentId !== paymentId) {
        throw new FirestoreDataIntegrityError("Vendor claim document identity mismatch");
      }
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
      if (
        nextState === "resource_generated" &&
        (!txSignature || !responseHash || patch.resourceContentType === undefined || patch.resourceBodyBase64 === undefined)
      ) {
        throw new Error("Generated resource requires settlement and persisted response bytes");
      }
      if (nextState === "receipt_signed" && (!txSignature || !responseHash || !receipt)) {
        throw new Error("Signed receipt requires settlement and generated resource bindings");
      }
      if (patch.resourceResponseHash && !Sha256Schema.safeParse(patch.resourceResponseHash).success) {
        throw new TypeError("resourceResponseHash is invalid");
      }
      const safePatch: VendorClaimTransitionPatch = {
        ...(patch.txSignature === undefined ? {} : { txSignature: patch.txSignature }),
        ...(patch.resourceResponseHash === undefined ? {} : { resourceResponseHash: patch.resourceResponseHash }),
        ...(patch.resourceContentType === undefined ? {} : { resourceContentType: patch.resourceContentType }),
        ...(patch.resourceBodyBase64 === undefined ? {} : { resourceBodyBase64: patch.resourceBodyBase64 }),
        ...(patch.fulfillmentReceipt === undefined
          ? {}
          : { fulfillmentReceipt: validateJsonValue(patch.fulfillmentReceipt, "fulfillmentReceipt") }),
      };
      const updated: VendorPaymentClaimRecord = {
        ...record,
        ...safePatch,
        state: nextState,
        version: record.version + 1,
        updatedAt: occurredAt,
      };
      transaction.set(reference, makeEnvelope(updated));
      this.writeAuditEvent(transaction, makeAuditEvent({
        eventId: deterministicEventId("vendor.claim.transition", {
          vendorTenant,
          paymentId,
          version: updated.version,
        }),
        type: "vendor.claim.transition",
        occurredAt,
        paymentId,
        ...(updated.txSignature ? { txSignature: updated.txSignature } : {}),
        payload: {
          vendorTenant,
          previousState: record.state,
          nextState,
          requestFingerprint: updated.requestFingerprint,
        },
      }));
      return clone(updated);
    }, { maxAttempts: this.transactionMaxAttempts });
  }

  /**
   * Deletes only a lock whose transaction proves settlement was never attempted.
   * Any attempted/ambiguous `settling` claim remains locked for reconciliation.
   */
  async releaseVendorClaimBeforeSubmission(
    vendorTenant: string,
    paymentId: string,
    expectedVersion: number,
  ): Promise<boolean> {
    validateIdentifier(vendorTenant, "vendorTenant");
    validateIdentifier(paymentId, "paymentId");
    const reference = this.vendorClaimDocument(vendorTenant, paymentId);
    return this.firestore.runTransaction(async (transaction) => {
      const record = parseEnvelope(await transaction.get(reference), parseVendorClaim);
      if (!record) return false;
      if (
        record.vendorTenant !== vendorTenant ||
        record.paymentId !== paymentId ||
        record.state !== "settling" ||
        record.version !== expectedVersion ||
        record.settlementAttempted
      ) {
        return false;
      }
      transaction.delete(reference);
      this.writeAuditEvent(transaction, makeAuditEvent({
        eventId: deterministicEventId("vendor.claim.released_before_submission", {
          vendorTenant,
          paymentId,
          version: record.version,
        }),
        type: "vendor.claim.released_before_submission",
        occurredAt: record.updatedAt,
        paymentId,
        payload: {
          vendorTenant,
          requestFingerprint: record.requestFingerprint,
          settlementAttempted: false,
        },
      }));
      return true;
    }, { maxAttempts: this.transactionMaxAttempts });
  }
}

export function createFirestoreTransactionalRepository(
  clientOptions?: FirestoreClientOptions,
  persistenceOptions: FirestorePersistenceOptions = {},
): FirestoreTransactionalRepository {
  const firestore = clientOptions === undefined ? new Firestore() : new Firestore(clientOptions);
  return new FirestoreTransactionalRepository(firestore, persistenceOptions);
}
