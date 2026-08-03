export const LIVE_OPERATOR_EVENT_KINDS = [
  "incident_sanitized",
  "a2a_offers_discovered",
  "gemini_offer_selected",
  "x402_402_received",
  "authoritative_context_persisted",
  "policy_denied",
  "policy_allowed",
  "payment_payload_signed",
  "paid_retry_sent",
  "settlement_confirmed",
  "fulfillment_receipt_verified",
  "recovery_resource_applied",
  "health_probe_healthy",
  "recovery_outcome_signed",
  "budget_committed",
  "reconciliation_required",
] as const;

export type LiveOperatorEventKind = (typeof LIVE_OPERATOR_EVENT_KINDS)[number];

export type LiveOperatorUiConfig =
  | Readonly<{ mode: "disabled" }>
  | Readonly<{
      mode: "google-oidc-live";
      clientId: string;
      audience: string;
    }>;

export type LiveOperatorUiEvent = Readonly<{
  phase: "primary" | "overTransactionLimit" | "replay";
  sequence: number;
  correlationId: string;
  kind: LiveOperatorEventKind;
  occurredAt: string;
  protocolLabel: string;
  transactionCreated: boolean;
}>;

export type LiveOperatorUiResponse = Readonly<{
  schemaVersion: "1";
  evidenceLevel: "live-unverified";
  separation: "application-role";
  runBindingHash: `sha256:${string}`;
  idempotentReplay: boolean;
  primary: Readonly<{
    outcome: "recovered" | "denied" | "reconciliation_required";
    transactionCreated: boolean;
    reasonCode?: string;
  }>;
  denials: Readonly<{
    overTransactionLimit: Readonly<{
      outcome: "denied";
      reasonCode: "amount.per_transaction_limit";
      transactionCreated: false;
    }>;
    replay: Readonly<{
      outcome: "denied";
      reasonCode: "identifier.nonce_fresh";
      transactionCreated: false;
    }>;
  }> | null;
  events: readonly LiveOperatorUiEvent[];
}>;

const EVENT_KIND_SET = new Set<string>(LIVE_OPERATOR_EVENT_KINDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key));
}

/** Browser-side fail-closed parser for the deliberately reduced live response. */
export function parseLiveOperatorUiResponse(value: unknown): LiveOperatorUiResponse {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "evidenceLevel",
      "separation",
      "runBindingHash",
      "idempotentReplay",
      "primary",
      "denials",
      "events",
    ]) ||
    value.schemaVersion !== "1" ||
    value.evidenceLevel !== "live-unverified" ||
    value.separation !== "application-role" ||
    typeof value.runBindingHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.runBindingHash) ||
    typeof value.idempotentReplay !== "boolean" ||
    !isRecord(value.primary) ||
    !hasOnlyKeys(value.primary, ["outcome", "transactionCreated", "reasonCode"]) ||
    !["recovered", "denied", "reconciliation_required"].includes(
      String(value.primary.outcome),
    ) ||
    typeof value.primary.transactionCreated !== "boolean" ||
    (value.primary.reasonCode !== undefined &&
      (typeof value.primary.reasonCode !== "string" || value.primary.reasonCode.length > 256)) ||
    !Array.isArray(value.events) ||
    value.events.length > 64
  ) {
    throw new TypeError("Live operator response is invalid");
  }

  for (const event of value.events) {
    if (
      !isRecord(event) ||
      !hasOnlyKeys(event, [
        "phase",
        "sequence",
        "correlationId",
        "kind",
        "occurredAt",
        "protocolLabel",
        "transactionCreated",
      ]) ||
      !["primary", "overTransactionLimit", "replay"].includes(
        String(event.phase),
      ) ||
      !Number.isInteger(event.sequence) ||
      Number(event.sequence) < 1 ||
      typeof event.correlationId !== "string" ||
      event.correlationId.length < 1 ||
      event.correlationId.length > 128 ||
      typeof event.kind !== "string" ||
      !EVENT_KIND_SET.has(event.kind) ||
      typeof event.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(event.occurredAt)) ||
      typeof event.protocolLabel !== "string" ||
      event.protocolLabel.length < 1 ||
      event.protocolLabel.length > 128 ||
      typeof event.transactionCreated !== "boolean"
    ) {
      throw new TypeError("Live operator event is invalid");
    }
  }

  if (value.denials !== null) {
    if (
      !isRecord(value.denials) ||
      !hasOnlyKeys(value.denials, ["overTransactionLimit", "replay"]) ||
      !isRecord(value.denials.overTransactionLimit) ||
      !hasOnlyKeys(value.denials.overTransactionLimit, [
        "outcome",
        "reasonCode",
        "transactionCreated",
      ]) ||
      value.denials.overTransactionLimit.outcome !== "denied" ||
      value.denials.overTransactionLimit.reasonCode !==
        "amount.per_transaction_limit" ||
      value.denials.overTransactionLimit.transactionCreated !== false ||
      !isRecord(value.denials.replay) ||
      !hasOnlyKeys(value.denials.replay, [
        "outcome",
        "reasonCode",
        "transactionCreated",
      ]) ||
      value.denials.replay.outcome !== "denied" ||
      value.denials.replay.reasonCode !== "identifier.nonce_fresh" ||
      value.denials.replay.transactionCreated !== false
    ) {
      throw new TypeError("Live operator dual-denial response is invalid");
    }
  }

  return value as LiveOperatorUiResponse;
}
