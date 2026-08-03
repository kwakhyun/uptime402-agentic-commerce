import {
  ExecutionPolicySchema,
  IncidentSchema,
  MandateSchema,
  PaymentProposalSchema,
  VendorOfferSchema,
  computeExecutionPolicyHash,
  computeMandateHash,
  computeVendorOfferHash,
  createRequestFingerprint,
  normalizeHttpsUrl,
  normalizePinnedHttpsUrl,
  normalizePinnedOrigin,
  type ExecutionPolicy,
  type Incident,
  type Mandate,
  type PaymentProposal,
  type VendorOffer,
} from "@uptime402/domain";

export const POLICY_RULES = [
  "mandate.exists",
  "schema.valid",
  "proposal.binds_authoritative_ids",
  "mandate.subject",
  "mandate.not_revoked",
  "mandate.hash",
  "mandate.attestation",
  "execution_policy.hash",
  "execution_policy.immutable_binding",
  "mandate.issuer",
  "mandate.time_window",
  "network.cluster",
  "network.genesis",
  "network.caip2",
  "network.sdk",
  "asset.mint",
  "asset.decimals",
  "capability.allowlist",
  "agent_card.allowlist",
  "vendor.origin",
  "facilitator.origin",
  "recipient.allowlist",
  "offer.hash",
  "offer.signature",
  "offer.expiry",
  "challenge.signature",
  "challenge.expiry",
  "challenge.binding",
  "request.method",
  "request.url",
  "request.body_hash",
  "request.operation_id",
  "request.fingerprint",
  "transport.redirects_disabled",
  "transport.public_addresses",
  "amount.positive",
  "amount.offer_coherent",
  "amount.per_transaction_limit",
  "identifier.payment_id_fresh",
  "identifier.nonce_fresh",
  "identifier.idempotency_key_fresh",
  "budget.incident_limit",
  "budget.daily_limit",
  "transaction.instructions",
  "transaction.program_allowlist",
  "transaction.account_allowlist",
  "transaction.fee_payer",
  "transaction.executor_public_key",
  "transaction.network_fee_limit",
  "signer.private_boundary",
  "signer.available",
  "signer.active_wallet",
] as const;

export type PolicyRule = (typeof POLICY_RULES)[number];
export type PolicyEvidenceValue = boolean | null | number | string | string[];

export type PolicyCheck = {
  rule: PolicyRule;
  expected: PolicyEvidenceValue;
  actual: PolicyEvidenceValue;
  pass: boolean;
};

export type PaymentChallenge = {
  verified: boolean;
  challengeHash: `sha256:${string}`;
  expiresAt: string;
  scheme: "exact";
  network: string;
  assetMint: string;
  amountBaseUnits: string;
  payee: string;
  method: "GET" | "POST";
  resourceUrl: string;
  facilitatorOrigin: string;
};

export type AuthoritativeRequest = {
  method: "GET" | "POST";
  resourceUrl: string;
  operationId: string;
  canonicalBodyHash: `sha256:${string}`;
};

export type IdentifierBinding = {
  requestFingerprint: string;
  reservationId: string;
};

export type PaymentPolicyContext = {
  now: string;
  expectedSubject: string;
  expectedIssuerPrincipal: string;
  requiredCapability: string;
  incident: Incident;
  mandate: Mandate | null;
  executionPolicy: ExecutionPolicy;
  offer: VendorOffer;
  proposal: PaymentProposal;
  challenge: PaymentChallenge;
  request: AuthoritativeRequest;
  verification: {
    mandateAttestation: boolean;
    offerSignature: boolean;
  };
  observedNetwork: {
    clusterLabel: "devnet" | "mainnet-beta";
    rpcGenesisHash: string;
    sdkNetworkId: string;
  };
  transport: {
    redirectsDisabled: boolean;
    resolvedAddressesPublic: boolean;
  };
  budget: {
    incidentCommittedAndReservedBaseUnits: string;
    dailyCommittedAndReservedBaseUnits: string;
  };
  identifiers: {
    paymentId?: IdentifierBinding;
    nonce?: IdentifierBinding;
    idempotencyKey?: IdentifierBinding;
  };
  transaction: {
    planVerified: boolean;
    programIds: string[];
    accountKeys: string[];
    feePayer: string;
    executorPublicKey: string;
    networkFeeUpperBoundLamports: string;
  };
  signer: {
    privateBoundaryVerified: boolean;
    available: boolean;
    activeWalletPublicKey: string;
  };
};

export type PolicyAllowDecision = {
  outcome: "allow";
  approved: true;
  canSign: true;
  transactionCreated: false;
  reasonCode: null;
  checks: PolicyCheck[];
};

export type PolicyDenyDecision = {
  outcome: "deny";
  approved: false;
  canSign: false;
  transactionCreated: false;
  reasonCode: PolicyRule;
  checks: PolicyCheck[];
};

export type PaymentPolicyDecision = PolicyAllowDecision | PolicyDenyDecision;

function allow(checks: PolicyCheck[]): PolicyAllowDecision {
  return {
    outcome: "allow",
    approved: true,
    canSign: true,
    transactionCreated: false,
    reasonCode: null,
    checks,
  };
}

function deny(checks: PolicyCheck[], reasonCode: PolicyRule): PolicyDenyDecision {
  return {
    outcome: "deny",
    approved: false,
    canSign: false,
    transactionCreated: false,
    reasonCode,
    checks,
  };
}

function asSafeActual(value: unknown): PolicyEvidenceValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  return "invalid";
}

function parseBaseUnits(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function isBefore(left: string, right: string): boolean {
  return Date.parse(left) < Date.parse(right);
}

function safeNormalizeOrigin(value: string): string | null {
  try {
    return normalizePinnedOrigin(value);
  } catch {
    return null;
  }
}

function safeNormalizeUrl(value: string, pinnedOrigin?: string): string | null {
  try {
    return pinnedOrigin ? normalizePinnedHttpsUrl(value, pinnedOrigin) : normalizeHttpsUrl(value);
  } catch {
    return null;
  }
}

/**
 * Pure execution-time authorization. It never reserves, signs, or creates a
 * transaction; callers may proceed to an atomic reserve only on `allow`.
 */
export function evaluatePaymentPolicy(context: PaymentPolicyContext): PaymentPolicyDecision {
  const checks: PolicyCheck[] = [];
  const check = (
    rule: PolicyRule,
    expected: PolicyEvidenceValue,
    actual: unknown,
    pass: boolean,
  ): PolicyDenyDecision | null => {
    checks.push({ rule, expected, actual: asSafeActual(actual), pass });
    return pass ? null : deny(checks, rule);
  };

  let denied = check("mandate.exists", true, context.mandate !== null, context.mandate !== null);
  if (denied) return denied;
  const mandate = context.mandate!;

  const parsedMandate = MandateSchema.safeParse(mandate);
  const parsedPolicy = ExecutionPolicySchema.safeParse(context.executionPolicy);
  const parsedIncident = IncidentSchema.safeParse(context.incident);
  const parsedOffer = VendorOfferSchema.safeParse(context.offer);
  const parsedProposal = PaymentProposalSchema.safeParse(context.proposal);
  const schemasValid =
    parsedMandate.success &&
    parsedPolicy.success &&
    parsedIncident.success &&
    parsedOffer.success &&
    parsedProposal.success;
  denied = check("schema.valid", true, schemasValid, schemasValid);
  if (denied) return denied;

  const policy = parsedPolicy.data!;
  const incident = parsedIncident.data!;
  const offer = parsedOffer.data!;
  const proposal = parsedProposal.data!;

  const idsBound =
    proposal.incidentId === incident.id &&
    proposal.mandateId === mandate.id &&
    proposal.offerId === offer.payload.offerId;
  denied = check(
    "proposal.binds_authoritative_ids",
    `${incident.id}|${mandate.id}|${offer.payload.offerId}`,
    `${proposal.incidentId}|${proposal.mandateId}|${proposal.offerId}`,
    idsBound,
  );
  if (denied) return denied;

  denied = check("mandate.subject", context.expectedSubject, mandate.subject, mandate.subject === context.expectedSubject);
  if (denied) return denied;

  denied = check("mandate.not_revoked", null, mandate.revokedAt ?? null, mandate.revokedAt === undefined);
  if (denied) return denied;

  const computedMandateHash = computeMandateHash(mandate);
  denied = check("mandate.hash", computedMandateHash, mandate.mandateHash, mandate.mandateHash === computedMandateHash);
  if (denied) return denied;

  denied = check(
    "mandate.attestation",
    true,
    context.verification.mandateAttestation,
    context.verification.mandateAttestation,
  );
  if (denied) return denied;

  const computedPolicyHash = computeExecutionPolicyHash(policy);
  denied = check("execution_policy.hash", computedPolicyHash, policy.policyHash, policy.policyHash === computedPolicyHash);
  if (denied) return denied;

  const policyBindingValid =
    mandate.executionPolicyHash === policy.policyHash && proposal.executionPolicyHash === policy.policyHash;
  denied = check(
    "execution_policy.immutable_binding",
    policy.policyHash,
    `${mandate.executionPolicyHash}|${proposal.executionPolicyHash}`,
    policyBindingValid,
  );
  if (denied) return denied;

  denied = check(
    "mandate.issuer",
    context.expectedIssuerPrincipal,
    mandate.issuerPrincipal,
    mandate.issuerPrincipal === context.expectedIssuerPrincipal,
  );
  if (denied) return denied;

  const mandateTimeValid =
    !isBefore(context.now, mandate.notBefore) &&
    isBefore(context.now, mandate.expiresAt) &&
    isBefore(context.now, proposal.expiresAt);
  denied = check(
    "mandate.time_window",
    `${mandate.notBefore} <= now < ${mandate.expiresAt} and proposal expiry`,
    context.now,
    mandateTimeValid,
  );
  if (denied) return denied;

  const clusterValid =
    context.observedNetwork.clusterLabel === mandate.clusterLabel &&
    proposal.network.clusterLabel === policy.network.clusterLabel &&
    proposal.network.clusterLabel === context.observedNetwork.clusterLabel;
  denied = check(
    "network.cluster",
    policy.network.clusterLabel,
    `${context.observedNetwork.clusterLabel}|${proposal.network.clusterLabel}|${mandate.clusterLabel}`,
    clusterValid,
  );
  if (denied) return denied;

  const genesisValid =
    context.observedNetwork.rpcGenesisHash === policy.network.genesisHash &&
    proposal.network.genesisHash === policy.network.genesisHash;
  denied = check(
    "network.genesis",
    policy.network.genesisHash,
    `${context.observedNetwork.rpcGenesisHash}|${proposal.network.genesisHash}`,
    genesisValid,
  );
  if (denied) return denied;

  const caip2Valid =
    proposal.network.x402NetworkId === policy.network.x402NetworkId &&
    offer.payload.network === policy.network.x402NetworkId;
  denied = check(
    "network.caip2",
    policy.network.x402NetworkId,
    `${proposal.network.x402NetworkId}|${offer.payload.network}`,
    caip2Valid,
  );
  if (denied) return denied;

  const sdkValid =
    context.observedNetwork.sdkNetworkId === policy.network.sdkNetworkId &&
    proposal.network.sdkNetworkId === policy.network.sdkNetworkId;
  denied = check(
    "network.sdk",
    policy.network.sdkNetworkId,
    `${context.observedNetwork.sdkNetworkId}|${proposal.network.sdkNetworkId}`,
    sdkValid,
  );
  if (denied) return denied;

  const mintValid =
    proposal.assetMint === policy.assetMint &&
    proposal.assetMint === mandate.assetMint &&
    proposal.assetMint === offer.payload.assetMint;
  denied = check(
    "asset.mint",
    policy.assetMint,
    `${proposal.assetMint}|${mandate.assetMint}|${offer.payload.assetMint}`,
    mintValid,
  );
  if (denied) return denied;

  denied = check("asset.decimals", 6, policy.assetDecimals, policy.assetDecimals === 6);
  if (denied) return denied;

  const capabilityValid =
    context.requiredCapability === offer.payload.capability &&
    mandate.allowedCapabilities.includes(offer.payload.capability ?? "");
  denied = check(
    "capability.allowlist",
    context.requiredCapability,
    offer.payload.capability ?? "missing",
    capabilityValid,
  );
  if (denied) return denied;

  denied = check(
    "agent_card.allowlist",
    mandate.allowedAgentCardHashes,
    offer.payload.providerAgentCardHash,
    mandate.allowedAgentCardHashes.includes(offer.payload.providerAgentCardHash),
  );
  if (denied) return denied;

  const providerUrl = safeNormalizeUrl(offer.payload.providerAgentCardUrl);
  const providerOrigin = providerUrl ? new URL(providerUrl).origin : null;
  const allowedVendorOrigins = mandate.allowedVendorOrigins.map(safeNormalizeOrigin);
  const vendorOriginValid = providerOrigin !== null && allowedVendorOrigins.includes(providerOrigin);
  denied = check("vendor.origin", mandate.allowedVendorOrigins, providerOrigin, vendorOriginValid);
  if (denied) return denied;

  const facilitatorOrigin = safeNormalizeOrigin(context.challenge.facilitatorOrigin);
  const allowedFacilitators = policy.allowedFacilitatorOrigins.map(safeNormalizeOrigin);
  const facilitatorValid = facilitatorOrigin !== null && allowedFacilitators.includes(facilitatorOrigin);
  denied = check(
    "facilitator.origin",
    policy.allowedFacilitatorOrigins,
    facilitatorOrigin,
    facilitatorValid,
  );
  if (denied) return denied;

  denied = check(
    "recipient.allowlist",
    mandate.allowedRecipients,
    proposal.recipient,
    mandate.allowedRecipients.includes(proposal.recipient) && proposal.recipient === offer.payload.payee,
  );
  if (denied) return denied;

  const computedOfferHash = computeVendorOfferHash(offer);
  denied = check("offer.hash", computedOfferHash, computedOfferHash, true);
  if (denied) return denied;

  denied = check("offer.signature", true, context.verification.offerSignature, context.verification.offerSignature);
  if (denied) return denied;

  denied = check(
    "offer.expiry",
    `now < ${offer.payload.expiresAt}`,
    context.now,
    isBefore(context.now, offer.payload.expiresAt),
  );
  if (denied) return denied;

  denied = check("challenge.signature", true, context.challenge.verified, context.challenge.verified);
  if (denied) return denied;

  denied = check(
    "challenge.expiry",
    `now < ${context.challenge.expiresAt}`,
    context.now,
    isBefore(context.now, context.challenge.expiresAt),
  );
  if (denied) return denied;

  const challengeBindingValid =
    context.challenge.scheme === "exact" &&
    context.challenge.challengeHash === proposal.challengeHash &&
    context.challenge.network === proposal.network.x402NetworkId &&
    context.challenge.assetMint === proposal.assetMint &&
    context.challenge.amountBaseUnits === proposal.amountBaseUnits &&
    context.challenge.payee === proposal.recipient;
  denied = check(
    "challenge.binding",
    `${proposal.challengeHash}|${proposal.network.x402NetworkId}|${proposal.assetMint}|${proposal.amountBaseUnits}|${proposal.recipient}`,
    `${context.challenge.challengeHash}|${context.challenge.network}|${context.challenge.assetMint}|${context.challenge.amountBaseUnits}|${context.challenge.payee}`,
    challengeBindingValid,
  );
  if (denied) return denied;

  const methodValid =
    proposal.method === offer.payload.method &&
    proposal.method === context.challenge.method &&
    proposal.method === context.request.method;
  denied = check(
    "request.method",
    proposal.method,
    `${offer.payload.method ?? "missing"}|${context.challenge.method}|${context.request.method}`,
    methodValid,
  );
  if (denied) return denied;

  const normalizedProposalUrl = safeNormalizeUrl(proposal.resourceUrl, providerOrigin ?? undefined);
  const normalizedOfferUrl = safeNormalizeUrl(offer.payload.resourceUrl, providerOrigin ?? undefined);
  const normalizedChallengeUrl = safeNormalizeUrl(context.challenge.resourceUrl, providerOrigin ?? undefined);
  const normalizedRequestUrl = safeNormalizeUrl(context.request.resourceUrl, providerOrigin ?? undefined);
  const urlValid =
    normalizedProposalUrl !== null &&
    normalizedProposalUrl === normalizedOfferUrl &&
    normalizedProposalUrl === normalizedChallengeUrl &&
    normalizedProposalUrl === normalizedRequestUrl;
  denied = check(
    "request.url",
    normalizedProposalUrl ?? "valid pinned HTTPS URL",
    normalizedOfferUrl && normalizedChallengeUrl && normalizedRequestUrl
      ? `${normalizedOfferUrl}|${normalizedChallengeUrl}|${normalizedRequestUrl}`
      : "invalid",
    urlValid,
  );
  if (denied) return denied;

  denied = check(
    "request.body_hash",
    proposal.canonicalBodyHash,
    context.request.canonicalBodyHash,
    proposal.canonicalBodyHash === context.request.canonicalBodyHash,
  );
  if (denied) return denied;

  denied = check(
    "request.operation_id",
    proposal.operationId,
    context.request.operationId,
    proposal.operationId === context.request.operationId,
  );
  if (denied) return denied;

  const computedFingerprint = createRequestFingerprint(
    {
      method: proposal.method,
      resourceUrl: normalizedProposalUrl!,
      operationId: proposal.operationId,
      canonicalBodyHash: proposal.canonicalBodyHash,
      paymentId: proposal.paymentId,
      scheme: "exact",
      network: proposal.network.x402NetworkId,
      assetMint: proposal.assetMint,
      amountBaseUnits: proposal.amountBaseUnits,
      payee: proposal.recipient,
    },
    { pinnedOrigin: providerOrigin! },
  );
  denied = check(
    "request.fingerprint",
    computedFingerprint,
    proposal.requestFingerprint,
    proposal.requestFingerprint === computedFingerprint,
  );
  if (denied) return denied;

  denied = check(
    "transport.redirects_disabled",
    true,
    context.transport.redirectsDisabled,
    context.transport.redirectsDisabled,
  );
  if (denied) return denied;

  denied = check(
    "transport.public_addresses",
    true,
    context.transport.resolvedAddressesPublic,
    context.transport.resolvedAddressesPublic,
  );
  if (denied) return denied;

  const amount = parseBaseUnits(proposal.amountBaseUnits);
  denied = check("amount.positive", "> 0", proposal.amountBaseUnits, amount !== null && amount > 0n);
  if (denied) return denied;

  const amountCoherent =
    proposal.amountBaseUnits === offer.payload.amountBaseUnits &&
    proposal.amountBaseUnits === context.challenge.amountBaseUnits;
  denied = check(
    "amount.offer_coherent",
    offer.payload.amountBaseUnits,
    `${proposal.amountBaseUnits}|${context.challenge.amountBaseUnits}`,
    amountCoherent,
  );
  if (denied) return denied;

  const perTransactionLimit = parseBaseUnits(mandate.perTransactionLimitBaseUnits)!;
  denied = check(
    "amount.per_transaction_limit",
    `<= ${mandate.perTransactionLimitBaseUnits}`,
    proposal.amountBaseUnits,
    amount! <= perTransactionLimit,
  );
  if (denied) return denied;

  denied = check(
    "identifier.payment_id_fresh",
    "unused",
    context.identifiers.paymentId?.requestFingerprint ?? "unused",
    context.identifiers.paymentId === undefined,
  );
  if (denied) return denied;

  denied = check(
    "identifier.nonce_fresh",
    "unused",
    context.identifiers.nonce?.requestFingerprint ?? "unused",
    context.identifiers.nonce === undefined,
  );
  if (denied) return denied;

  denied = check(
    "identifier.idempotency_key_fresh",
    "unused",
    context.identifiers.idempotencyKey?.requestFingerprint ?? "unused",
    context.identifiers.idempotencyKey === undefined,
  );
  if (denied) return denied;

  const incidentUsed = parseBaseUnits(context.budget.incidentCommittedAndReservedBaseUnits);
  const incidentLimit = parseBaseUnits(mandate.incidentLimitBaseUnits)!;
  const incidentWithinLimit = incidentUsed !== null && incidentUsed + amount! <= incidentLimit;
  denied = check(
    "budget.incident_limit",
    `<= ${mandate.incidentLimitBaseUnits}`,
    incidentUsed === null ? "invalid" : (incidentUsed + amount!).toString(),
    incidentWithinLimit,
  );
  if (denied) return denied;

  const dailyUsed = parseBaseUnits(context.budget.dailyCommittedAndReservedBaseUnits);
  const dailyLimit = parseBaseUnits(mandate.dailyLimitBaseUnits)!;
  const dailyWithinLimit = dailyUsed !== null && dailyUsed + amount! <= dailyLimit;
  denied = check(
    "budget.daily_limit",
    `<= ${mandate.dailyLimitBaseUnits}`,
    dailyUsed === null ? "invalid" : (dailyUsed + amount!).toString(),
    dailyWithinLimit,
  );
  if (denied) return denied;

  denied = check(
    "transaction.instructions",
    "expected SDK transaction plan validated; exact bytes rechecked after signing",
    context.transaction.planVerified,
    context.transaction.planVerified,
  );
  if (denied) return denied;

  const programsAllowed =
    context.transaction.programIds.length > 0 &&
    context.transaction.programIds.every((id) => policy.allowedProgramIds.includes(id));
  denied = check(
    "transaction.program_allowlist",
    policy.allowedProgramIds,
    context.transaction.programIds,
    programsAllowed,
  );
  if (denied) return denied;

  const accountsAllowed =
    context.transaction.accountKeys.length > 0 &&
    context.transaction.accountKeys.every((key) => policy.allowedAccountRules.includes(key));
  denied = check(
    "transaction.account_allowlist",
    policy.allowedAccountRules,
    context.transaction.accountKeys,
    accountsAllowed,
  );
  if (denied) return denied;

  denied = check(
    "transaction.fee_payer",
    policy.feePayer,
    context.transaction.feePayer,
    context.transaction.feePayer === policy.feePayer,
  );
  if (denied) return denied;

  denied = check(
    "transaction.executor_public_key",
    policy.executorPublicKey,
    context.transaction.executorPublicKey,
    context.transaction.executorPublicKey === policy.executorPublicKey,
  );
  if (denied) return denied;

  const configuredFeeUpperBound = parseBaseUnits(context.transaction.networkFeeUpperBoundLamports);
  const maxFee = parseBaseUnits(policy.maxNetworkFeeLamports)!;
  denied = check(
    "transaction.network_fee_limit",
    `<= ${policy.maxNetworkFeeLamports}`,
    context.transaction.networkFeeUpperBoundLamports,
    configuredFeeUpperBound !== null && configuredFeeUpperBound <= maxFee,
  );
  if (denied) return denied;

  denied = check(
    "signer.private_boundary",
    true,
    context.signer.privateBoundaryVerified,
    context.signer.privateBoundaryVerified,
  );
  if (denied) return denied;

  denied = check("signer.available", true, context.signer.available, context.signer.available);
  if (denied) return denied;

  denied = check(
    "signer.active_wallet",
    policy.executorPublicKey,
    context.signer.activeWalletPublicKey,
    context.signer.activeWalletPublicKey === policy.executorPublicKey,
  );
  if (denied) return denied;

  return allow(checks);
}
