import { describe, expect, it } from "vitest";

import {
  DEVNET_GENESIS_HASH,
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  EMPTY_BODY_HASH,
  MandateSchema,
  canonicalHash,
  canonicalize,
  computeExecutionPolicyHash,
  computeMandateHash,
  createIncidentRunBindingHash,
  createNetworkIdentity,
  createRequestFingerprint,
  deriveSolanaCaip2NetworkId,
  hashCanonicalJsonBody,
  normalizePinnedHttpsUrl,
  type ExecutionPolicy,
  type ExecutionPolicyUnsigned,
  type Mandate,
  type MandateUnsigned,
  type VendorOffer,
  type VendorOfferPayload,
} from "@uptime402/domain";
import {
  POLICY_RULES,
  evaluatePaymentPolicy,
  type PaymentPolicyContext,
} from "@uptime402/policy";
import {
  InMemoryPersistenceBackend,
  InMemoryTransactionalRepository,
  type ReserveBudgetRequest,
} from "@uptime402/persistence";

const NOW = "2026-08-03T12:05:00+09:00";
const EXECUTOR = "3".repeat(44);
const PAYEE = "4".repeat(44);
const OTHER_PAYEE = "5".repeat(44);
const PROGRAM = "6".repeat(44);
const ACCOUNT = "7".repeat(44);
const AGENT_CARD_HASH = canonicalHash({ fixture: "agent-card" });
const FACILITATOR_ORIGIN = "https://facilitator.example";
const PROVIDER_ORIGIN = "https://vendor.example";
const RESOURCE_URL = `${PROVIDER_ORIGIN}/recover?a=1&z=2`;

const network = createNetworkIdentity({
  clusterLabel: "devnet",
  genesisHash: DEVNET_GENESIS_HASH,
  sdkNetworkId: "fixture-sdk-devnet",
});

function makePolicy(): ExecutionPolicy {
  const unsigned: ExecutionPolicyUnsigned = {
    id: "policy-v1",
    version: 1,
    network,
    assetMint: DEVNET_USDC_MINT,
    assetDecimals: 6,
    executorPublicKey: EXECUTOR,
    feePayer: EXECUTOR,
    maxNetworkFeeLamports: "10000",
    allowedProgramIds: [PROGRAM],
    allowedAccountRules: [ACCOUNT],
    allowedFacilitatorOrigins: [FACILITATOR_ORIGIN],
    maxResponseBytes: 65_536,
  };
  return { ...unsigned, policyHash: computeExecutionPolicyHash(unsigned) };
}

function makeMandate(policy: ExecutionPolicy, overrides: Partial<MandateUnsigned> = {}): Mandate {
  const unsigned: MandateUnsigned = {
    id: "mandate-1",
    subject: "service:control-plane",
    clusterLabel: "devnet",
    assetMint: DEVNET_USDC_MINT,
    perTransactionLimitBaseUnits: "20000",
    incidentLimitBaseUnits: "50000",
    dailyLimitBaseUnits: "100000",
    allowedRecipients: [PAYEE],
    allowedCapabilities: ["solana-rpc-health"],
    allowedVendorOrigins: [PROVIDER_ORIGIN],
    allowedAgentCardHashes: [AGENT_CARD_HASH],
    notBefore: "2026-08-03T11:59:00+09:00",
    expiresAt: "2026-08-03T12:10:00+09:00",
    nonce: "mandate-nonce-1",
    issuerPrincipal: "operator@example.test",
    issuedAt: "2026-08-03T11:58:00+09:00",
    executionPolicyHash: policy.policyHash,
    protocolLabel: "internal",
    ...overrides,
  };
  return MandateSchema.parse({
    ...unsigned,
    mandateHash: computeMandateHash(unsigned),
    attestation: { kid: "operator-key-1", algorithm: "EdDSA", signature: "fixture-signature" },
  });
}

function makeOffer(amountBaseUnits: string): VendorOffer {
  const payload: VendorOfferPayload = {
    offerId: "offer-fast",
    providerAgentId: "vendor-1",
    providerAgentCardUrl: `${PROVIDER_ORIGIN}/.well-known/agent-card.json`,
    providerAgentCardHash: AGENT_CARD_HASH,
    resourceUrl: RESOURCE_URL,
    network: DEVNET_X402_NETWORK_ID,
    asset: "USDC",
    assetMint: DEVNET_USDC_MINT,
    amountBaseUnits,
    payee: PAYEE,
    expiresAt: "2026-08-03T12:09:00+09:00",
    capability: "solana-rpc-health",
    method: "POST",
  };
  return {
    payload,
    signer: "8".repeat(44),
    keyId: "vendor-key-1",
    signature: "S".repeat(88),
  };
}

function makeContext(amountBaseUnits = "20000"): PaymentPolicyContext {
  const policy = makePolicy();
  const mandate = makeMandate(policy);
  const offer = makeOffer(amountBaseUnits);
  const canonicalBodyHash = hashCanonicalJsonBody({ incidentId: "incident-1" });
  const challengeHash = canonicalHash({ amountBaseUnits, fixture: "402-challenge" });
  const requestFingerprint = createRequestFingerprint(
    {
      method: "POST",
      resourceUrl: RESOURCE_URL,
      operationId: "recover-rpc",
      canonicalBodyHash,
      paymentId: "payment-1",
      scheme: "exact",
      network: network.x402NetworkId,
      assetMint: DEVNET_USDC_MINT,
      amountBaseUnits,
      payee: PAYEE,
    },
    { pinnedOrigin: PROVIDER_ORIGIN },
  );

  return {
    now: NOW,
    expectedSubject: mandate.subject,
    expectedIssuerPrincipal: mandate.issuerPrincipal,
    requiredCapability: offer.payload.capability!,
    incident: {
      id: "incident-1",
      service: "checkout-rpc",
      signal: "rpc-unhealthy",
      observedAt: "2026-08-03T12:04:30+09:00",
      healthBefore: "down",
      sanitizedTelemetry: { errorClass: "RpcTimeout", statusCode: 503, latencyMs: 5_000 },
      redactionReportHash: canonicalHash({ fixture: "redaction-report" }),
    },
    mandate,
    executionPolicy: policy,
    offer,
    proposal: {
      incidentId: "incident-1",
      mandateId: mandate.id,
      offerId: offer.payload.offerId,
      operationId: "recover-rpc",
      executionPolicyHash: policy.policyHash,
      network,
      method: "POST",
      resourceUrl: RESOURCE_URL,
      canonicalBodyHash,
      requestFingerprint,
      recipient: PAYEE,
      assetMint: DEVNET_USDC_MINT,
      amountBaseUnits,
      challengeHash,
      paymentId: "payment-1",
      nonce: "payment-nonce-1",
      expiresAt: "2026-08-03T12:08:00+09:00",
      idempotencyKey: "idempotency-1",
    },
    challenge: {
      verified: true,
      challengeHash,
      expiresAt: "2026-08-03T12:08:00+09:00",
      scheme: "exact",
      network: network.x402NetworkId,
      assetMint: DEVNET_USDC_MINT,
      amountBaseUnits,
      payee: PAYEE,
      method: "POST",
      resourceUrl: RESOURCE_URL,
      facilitatorOrigin: FACILITATOR_ORIGIN,
    },
    request: {
      method: "POST",
      resourceUrl: RESOURCE_URL,
      operationId: "recover-rpc",
      canonicalBodyHash,
    },
    verification: { mandateAttestation: true, offerSignature: true },
    observedNetwork: {
      clusterLabel: "devnet",
      rpcGenesisHash: DEVNET_GENESIS_HASH,
      sdkNetworkId: network.sdkNetworkId,
    },
    transport: { redirectsDisabled: true, resolvedAddressesPublic: true },
    budget: {
      incidentCommittedAndReservedBaseUnits: "0",
      dailyCommittedAndReservedBaseUnits: "0",
    },
    identifiers: {},
    transaction: {
      planVerified: true,
      programIds: [PROGRAM],
      accountKeys: [ACCOUNT],
      feePayer: EXECUTOR,
      executorPublicKey: EXECUTOR,
      networkFeeUpperBoundLamports: "5000",
    },
    signer: { privateBoundaryVerified: true, available: true, activeWalletPublicKey: EXECUTOR },
  };
}

function withRehashedMandate(context: PaymentPolicyContext, changes: Partial<MandateUnsigned>): PaymentPolicyContext {
  const mandate = makeMandate(context.executionPolicy, changes);
  return { ...context, mandate };
}

describe("domain canonical contracts", () => {
  it("pins Devnet genesis -> CAIP-2 and keeps SDK identity separate", () => {
    expect(deriveSolanaCaip2NetworkId(DEVNET_GENESIS_HASH)).toBe(DEVNET_X402_NETWORK_ID);
    expect(network).toEqual({
      clusterLabel: "devnet",
      genesisHash: DEVNET_GENESIS_HASH,
      x402NetworkId: DEVNET_X402_NETWORK_ID,
      sdkNetworkId: "fixture-sdk-devnet",
    });
    expect(EMPTY_BODY_HASH).toBe("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("canonicalizes objects and changes the hash on a bound-field mutation", () => {
    expect(canonicalize({ z: 1, a: { y: 2, x: "ok" } })).toBe('{"a":{"x":"ok","y":2},"z":1}');
    expect(canonicalHash({ amountBaseUnits: "20000", payee: PAYEE })).not.toBe(
      canonicalHash({ amountBaseUnits: "20001", payee: PAYEE }),
    );
    expect(() => canonicalize({ bad: undefined })).toThrow(/Non-JSON/);
  });

  it("normalizes only a pinned public HTTPS origin and blocks SSRF shapes", () => {
    expect(
      normalizePinnedHttpsUrl("https://VENDOR.EXAMPLE:443/a/../recover?z=2&a=1", PROVIDER_ORIGIN),
    ).toBe(RESOURCE_URL);
    expect(() => normalizePinnedHttpsUrl("https://vendor.example/recover?a=1&a=2", PROVIDER_ORIGIN)).toThrow(
      /Duplicate query/,
    );
    expect(() => normalizePinnedHttpsUrl("https://user:pass@vendor.example/recover", PROVIDER_ORIGIN)).toThrow(
      /credentials/,
    );
    expect(() => normalizePinnedHttpsUrl("https://vendor.example/recover#proof", PROVIDER_ORIGIN)).toThrow(
      /fragments/,
    );
    expect(() => normalizePinnedHttpsUrl("https://other.example/recover", PROVIDER_ORIGIN)).toThrow(/pinned origin/);
    expect(() => normalizePinnedHttpsUrl("https://169.254.169.254/latest", "https://169.254.169.254")).toThrow(
      /non-public/,
    );
    expect(() => normalizePinnedHttpsUrl("https://metadata.google.internal/", "https://metadata.google.internal")).toThrow(
      /non-public/,
    );
  });

  it("pins the request fingerprint mapping", () => {
    const fingerprint = createRequestFingerprint(
      {
        method: "POST",
        resourceUrl: RESOURCE_URL,
        operationId: "recover-rpc",
        canonicalBodyHash: EMPTY_BODY_HASH,
        paymentId: "payment-golden",
        scheme: "exact",
        network: DEVNET_X402_NETWORK_ID,
        assetMint: DEVNET_USDC_MINT,
        amountBaseUnits: "20000",
        payee: PAYEE,
      },
      { pinnedOrigin: PROVIDER_ORIGIN },
    );
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fingerprint).toBe(createRequestFingerprint({
      method: "POST",
      resourceUrl: "https://vendor.example/recover?z=2&a=1",
      operationId: "recover-rpc",
      canonicalBodyHash: EMPTY_BODY_HASH,
      paymentId: "payment-golden",
      scheme: "exact",
      network: DEVNET_X402_NETWORK_ID,
      assetMint: DEVNET_USDC_MINT,
      amountBaseUnits: "20000",
      payee: PAYEE,
    }, { pinnedOrigin: PROVIDER_ORIGIN }));
  });

  it("pins the incident run binding and changes it for every bound field", () => {
    const binding = {
      incidentId: "incident-live-001",
      mandateId: "mandate-live-001",
      operationId: "recover-rpc",
      paymentId: "payment-live-001",
      nonce: "nonce-live-001",
      idempotencyKey: "idempotency-live-001",
      executionPolicyHash: `sha256:${"2".repeat(64)}` as const,
    };
    const golden = createIncidentRunBindingHash(binding);
    expect(golden).toBe(
      "sha256:a58962b60ac0bb82223812d364cec5797b84d723e32914cdcd795ed89453cec5",
    );

    const mutations = [
      { ...binding, incidentId: "incident-live-002" },
      { ...binding, mandateId: "mandate-live-002" },
      { ...binding, operationId: "recover-rpc-alternate" },
      { ...binding, paymentId: "payment-live-002" },
      { ...binding, nonce: "nonce-live-002" },
      { ...binding, idempotencyKey: "idempotency-live-002" },
      { ...binding, executionPolicyHash: `sha256:${"3".repeat(64)}` as const },
    ];
    for (const mutation of mutations) {
      expect(createIncidentRunBindingHash(mutation)).not.toBe(golden);
    }
  });
});

describe("deterministic execution policy", () => {
  it("allows the exact cap and emits every ordered rule with no transaction yet", () => {
    const decision = evaluatePaymentPolicy(makeContext("20000"));
    expect(decision.outcome).toBe("allow");
    expect(decision.transactionCreated).toBe(false);
    expect(decision.checks.map(({ rule }) => rule)).toEqual(POLICY_RULES);
    expect(decision.checks.every(({ pass }) => pass)).toBe(true);
  });

  it("denies cap+1 without a transaction", () => {
    const decision = evaluatePaymentPolicy(makeContext("20001"));
    expect(decision).toMatchObject({
      outcome: "deny",
      reasonCode: "amount.per_transaction_limit",
      transactionCreated: false,
    });
  });

  it("prioritizes identifier replay over exhausted aggregate budget, but never over the per-transaction cap", () => {
    const replayBinding = {
      nonce: {
        requestFingerprint: canonicalHash({ original: true }),
        reservationId: "reservation-original",
      },
    };
    const exhaustedBudget = {
      incidentCommittedAndReservedBaseUnits: "50000",
      dailyCommittedAndReservedBaseUnits: "100000",
    };

    const replay = evaluatePaymentPolicy({
      ...makeContext("20000"),
      budget: exhaustedBudget,
      identifiers: replayBinding,
    });
    expect(replay).toMatchObject({
      outcome: "deny",
      reasonCode: "identifier.nonce_fresh",
      transactionCreated: false,
    });
    expect(replay.checks.at(-1)?.rule).toBe("identifier.nonce_fresh");

    const overCapReplay = evaluatePaymentPolicy({
      ...makeContext("20001"),
      budget: exhaustedBudget,
      identifiers: replayBinding,
    });
    expect(overCapReplay).toMatchObject({
      outcome: "deny",
      reasonCode: "amount.per_transaction_limit",
      transactionCreated: false,
    });
  });

  it.each([
    ["expired", (context: PaymentPolicyContext) => withRehashedMandate(context, { expiresAt: "2026-08-03T12:04:59+09:00" }), "mandate.time_window"],
    ["revoked", (context: PaymentPolicyContext) => withRehashedMandate(context, { revokedAt: "2026-08-03T12:04:00+09:00" }), "mandate.not_revoked"],
    ["wrong mint", (context: PaymentPolicyContext) => ({ ...context, proposal: { ...context.proposal, assetMint: OTHER_PAYEE } }), "asset.mint"],
    ["wrong network", (context: PaymentPolicyContext) => ({ ...context, proposal: { ...context.proposal, network: { ...context.proposal.network, clusterLabel: "mainnet-beta" as const } } }), "network.cluster"],
    ["wrong recipient", (context: PaymentPolicyContext) => ({ ...context, proposal: { ...context.proposal, recipient: OTHER_PAYEE } }), "recipient.allowlist"],
    ["nonce replay", (context: PaymentPolicyContext) => ({ ...context, identifiers: { nonce: { requestFingerprint: canonicalHash({ other: true }), reservationId: "reservation-old" } } }), "identifier.nonce_fresh"],
  ])("denies %s at its deterministic rule", (_name, mutate, expectedRule) => {
    const decision = evaluatePaymentPolicy(mutate(makeContext()));
    expect(decision).toMatchObject({ outcome: "deny", reasonCode: expectedRule, transactionCreated: false });
  });
});

function reservationRequest(index: number, amountBaseUnits = "600"): ReserveBudgetRequest {
  return {
    reservationId: `reservation-${index}`,
    incidentId: "incident-budget",
    mandateId: "mandate-budget",
    paymentId: `payment-${index}`,
    nonce: `nonce-${index}`,
    idempotencyKey: `idempotency-${index}`,
    requestFingerprint: canonicalHash({ index }),
    amountBaseUnits,
    incidentLimitBaseUnits: "1000",
    dailyLimitBaseUnits: "1000",
    occurredAt: NOW,
  };
}

describe("transactional in-memory persistence contract", () => {
  it("atomically prevents concurrent overspend and returns an idempotent reservation", async () => {
    const backend = new InMemoryPersistenceBackend();
    const firstInstance = new InMemoryTransactionalRepository(backend);
    const secondInstance = new InMemoryTransactionalRepository(backend);
    const [first, second] = await Promise.all([
      firstInstance.reserveBudget(reservationRequest(1)),
      secondInstance.reserveBudget(reservationRequest(2)),
    ]);
    expect([first.kind, second.kind].sort()).toEqual(["budget_exceeded", "reserved"]);
    const winnerRequest = first.kind === "reserved" ? reservationRequest(1) : reservationRequest(2);
    const replay = await secondInstance.reserveBudget(winnerRequest);
    expect(replay.kind).toBe("existing");
    const usage = await firstInstance.getBudgetUsage("mandate-budget", "incident-budget", NOW);
    expect(usage).toEqual({
      incidentCommittedAndReservedBaseUnits: "600",
      dailyCommittedAndReservedBaseUnits: "600",
    });
  });

  it("returns a nonce conflict before exhausted held budget", async () => {
    const repository = new InMemoryTransactionalRepository();
    const held = {
      ...reservationRequest(10, "1000"),
      incidentId: "incident-held",
    };
    const reserved = await repository.reserveBudget(held);
    expect(reserved).toMatchObject({ kind: "reserved" });
    if (reserved.kind !== "reserved") throw new Error("held-budget fixture did not reserve");
    const submitted = await repository.transitionReservation(
      reserved.record.reservationId,
      ["reserved"],
      "submitted",
      NOW,
    );
    await expect(
      repository.transitionReservation(submitted.reservationId, ["submitted"], "unknown", NOW),
    ).resolves.toMatchObject({ state: "unknown" });

    await expect(repository.reserveBudget({
      ...reservationRequest(11, "1"),
      nonce: held.nonce,
    })).resolves.toMatchObject({
      kind: "conflict",
      reason: "nonce",
      existingReservationId: held.reservationId,
    });
  });

  it("binds vendor paymentId to its first fingerprint across two instances", async () => {
    const backend = new InMemoryPersistenceBackend();
    const firstInstance = new InMemoryTransactionalRepository(backend);
    const secondInstance = new InMemoryTransactionalRepository(backend);
    const request = {
      vendorTenant: "vendor-1",
      paymentId: "payment-shared",
      requestFingerprint: canonicalHash({ request: 1 }),
      occurredAt: NOW,
    };
    const [first, second] = await Promise.all([
      firstInstance.claimVendorPayment(request),
      secondInstance.claimVendorPayment(request),
    ]);
    expect([first.kind, second.kind].sort()).toEqual(["acquired", "reconcile_required"]);
    const conflict = await secondInstance.claimVendorPayment({
      ...request,
      requestFingerprint: canonicalHash({ request: 2 }),
    });
    expect(conflict).toMatchObject({ kind: "conflict", httpStatus: 409 });
    const ambiguous = await secondInstance.claimVendorPayment(request);
    expect(ambiguous).toMatchObject({ kind: "reconcile_required", reason: "ambiguous_settling" });
  });
});
