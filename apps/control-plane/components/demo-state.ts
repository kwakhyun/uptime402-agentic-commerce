export type DemoEvidenceLevel =
  | "pending"
  | "local-simulated"
  | "live-unverified"
  | "devnet-verified";

export type TimelineStepState =
  | "waiting"
  | "running"
  | "local-simulated"
  | "devnet-verified"
  | "denied";

export interface MissionTimelineStep {
  id:
    | "incident"
    | "gemini"
    | "a2a"
    | "challenge"
    | "policy"
    | "retry"
    | "settle"
    | "resource"
    | "recovery"
    | "denial";
  protocolLabel: string;
  title: string;
  summary: string;
  detail: string;
  timeLabel: string;
  state: TimelineStepState;
}

export interface ImmutableOfferView {
  offerId: string;
  revision: string;
  capability: "solana-rpc-health";
  vendorLabel: string;
  priceUsdc: string;
  estimatedRecoverySeconds?: number;
  latencyP95Ms?: number;
  expiresAtLabel: string;
  signedOfferVerified: boolean;
  selected: boolean;
}

export interface MandateView {
  status: "active" | "revoked";
  incidentCapUsdc: string;
  perTransactionCapUsdc: string;
  durationMinutes: number | null;
  asset: "USDC";
  capability: "solana-rpc-health";
  remainingUsdc: string;
}

export interface DenialEvidenceView {
  id: string;
  rule:
    | "perTransactionCap"
    | "nonceReplay"
    | "idempotencyReplay"
    | "paymentIdReplay";
  title: string;
  attemptedAt: string;
  requestedValue: string;
  policyValue: string;
  executionPolicyHash?: string;
  transactionCreated: false;
  txSignature: null;
  artifactHash?: string;
  replayProof?: Readonly<{
    identifierType: "nonce" | "idempotencyKey" | "paymentId";
    identifierValue: string;
    originalPaymentId: string;
    deniedPaymentId: string;
    originalIncidentId: string;
    deniedIncidentId: string;
    originalNonce: string;
    deniedNonce: string;
    originalIdempotencyKey: string;
    deniedIdempotencyKey: string;
    originalTxSignature: string;
    originalExplorerUrl: string;
  }>;
  evidenceLevel: "local-simulated" | "devnet-verified";
}

export interface VerifiedPaymentEvidenceView {
  level: "devnet-verified";
  paymentId: string;
  runBindingHash: string;
  offerId: string;
  agentCardUrl: string;
  agentCardHash: string;
  offerSignerPublicKey: string;
  offerSignerKeyId: string;
  offerSignature: string;
  network: string;
  genesisHash: string;
  sdkNetworkId: string;
  mint: string;
  amountUsdc: string;
  amountBaseUnits: string;
  budgetBeforeBaseUnits: string;
  budgetAfterBaseUnits: string;
  payerOwner: string;
  payeeOwner: string;
  payerTokenDeltaBaseUnits: string;
  payeeTokenDeltaBaseUnits: string;
  tokenAccountDeltas: readonly {
    accountIndex: number;
    tokenAccount: string;
    owner: string;
    mint: string;
    decimals: number;
    preAmountBaseUnits: string;
    postAmountBaseUnits: string;
    deltaBaseUnits: string;
  }[];
  transactionSignature: string;
  explorerUrl: string;
  confirmationStatus: "confirmed" | "finalized";
  confirmationSlot: number;
  resourceUrl: string;
  operationId: string;
  canonicalBodyHash: string;
  executionPolicyHash: string;
  challengeHash: string;
  requestFingerprint: string;
  resourceResponseHash: string;
  x402Headers: readonly {
    name: "PAYMENT-REQUIRED" | "PAYMENT-SIGNATURE" | "PAYMENT-RESPONSE";
    status: 402 | 200 | "PAID RETRY";
    value: string;
    capturedAt: string;
  }[];
  paymentRequiredHeaderHash: string;
  paymentSignatureHeaderHash: string;
  paymentResponseHeaderHash: string;
  reservationId: string;
  reservationStateHistory: readonly [
    "reserved",
    "submitted",
    "confirmed",
    "fulfilled",
    "committed",
  ];
  policyRules: readonly {
    rule: string;
    expected: string | number | boolean | null;
    actual: string | number | boolean | null;
    pass: true;
  }[];
  fulfillmentReceiptHash: string;
  receiptSignerPublicKey: string;
  receiptKeyId: string;
  receiptSignature: string;
  receiptBindings: Readonly<{
    incidentId: string;
    offerId: string;
    paymentId: string;
    executionPolicyHash: string;
    challengeHash: string;
    requestFingerprint: string;
    transactionSignature: string;
    resourceResponseHash: string;
  }>;
  receiptVerified: true;
  outcomeSignerPublicKey: string;
  outcomeKeyId: string;
  outcomeSignature: string;
  healthProbeHash: string;
  outcomeArtifactHash: string;
  outcomeVerified: true;
  recoveryTimeMs: number;
  confirmedAt: string;
}

export interface PendingPaymentEvidenceView {
  level: "pending" | "local-simulated";
}

export type PaymentEvidenceView =
  | VerifiedPaymentEvidenceView
  | PendingPaymentEvidenceView;

export interface MissionControlDemoState {
  schemaVersion: "1.0";
  adapter: "local-ui-preview" | "control-plane-api" | "verified-evidence-artifact";
  evidenceLevel: DemoEvidenceLevel;
  incidentId: string;
  environmentLabel: "LOCAL SIMULATION" | "LIVE UNVERIFIED" | "DEVNET VERIFIED";
  dependency: {
    label: string;
    state: "unhealthy" | "recovering" | "healthy";
    healthDetail: string;
  };
  cluster: {
    label: "Solana Devnet";
    caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
  };
  killSwitch: {
    engaged: boolean;
    label: string;
  };
  mandate: MandateView;
  modelDecision: {
    provider: "Gemini";
    modeLabel: "SIMULATED ADAPTER" | "STRUCTURED OUTPUT VERIFIED";
    selectedOfferId: string;
    counterfactualOfferId: string;
    capability: "solana-rpc-health";
    rationale: string;
    counterfactualResult: string;
  };
  offers: readonly [ImmutableOfferView, ImmutableOfferView];
  timeline: readonly MissionTimelineStep[];
  paymentEvidence: PaymentEvidenceView;
  denials: readonly DenialEvidenceView[];
}

const TIMELINE_COPY: ReadonlyArray<
  Omit<MissionTimelineStep, "state" | "timeLabel">
> = [
  {
    id: "incident",
    protocolLabel: "INCIDENT",
    title: "Primary RPC 장애",
    summary: "health probe가 연속 실패했습니다.",
    detail: "테스트 fixture가 unhealthy telemetry를 생성합니다. 고객 식별자와 credential은 포함하지 않습니다.",
  },
  {
    id: "gemini",
    protocolLabel: "GEMINI",
    title: "진단 · capability 제안",
    summary: "허용된 telemetry로 solana-rpc-health를 제안합니다.",
    detail: "모델은 supplied offerId만 비교합니다. 금액 계산, 정책 변경, key 접근, raw transaction 서명 권한은 없습니다.",
  },
  {
    id: "a2a",
    protocolLabel: "A2A",
    title: "Agent Card · 2 offers",
    summary: "별도 vendor agent에서 immutable offer 두 개를 발견합니다.",
    detail: "offer 설명은 untrusted data로 처리하며, strict schema와 signed offer 검증을 통과해야 합니다.",
  },
  {
    id: "challenge",
    protocolLabel: "HTTP 402",
    title: "Payment Required",
    summary: "유료 recovery resource가 x402 challenge를 반환합니다.",
    detail: "PAYMENT-REQUIRED header와 request fingerprint를 검증합니다. 이 UI preview는 실제 challenge를 생성하지 않습니다.",
  },
  {
    id: "policy",
    protocolLabel: "POLICY / SIGN",
    title: "Reserve · 자동 payload 서명",
    summary: "executor가 authoritative policy를 재확인합니다.",
    detail: "application-enforced policy와 low-balance blast-radius isolation 아래 payment payload만 서명합니다. executor가 먼저 broadcast하지 않습니다.",
  },
  {
    id: "retry",
    protocolLabel: "PAID RETRY",
    title: "PAYMENT-SIGNATURE 재요청",
    summary: "사람의 건별 승인 없이 같은 요청을 재시도합니다.",
    detail: "운영자 wallet popup이나 결제 승인 버튼은 없습니다. 최초 mandate 경계만 적용됩니다.",
  },
  {
    id: "settle",
    protocolLabel: "VERIFY / SETTLE",
    title: "Vendor atomic claim",
    summary: "paymentId를 원자적으로 claim하고 verify/settle합니다.",
    detail: "confirmed settlement 전에는 resource를 반환하지 않으며 ambiguous settling은 reconcile 대상으로 유지합니다.",
  },
  {
    id: "resource",
    protocolLabel: "HTTP 200",
    title: "Recovery resource 제공",
    summary: "verified settlement 뒤 signed receipt와 함께 반환됩니다.",
    detail: "receipt는 offer, challenge, request, transaction, response, incident를 서로 bind해야 합니다.",
  },
  {
    id: "recovery",
    protocolLabel: "RECOVERY",
    title: "Dependency green",
    summary: "복구 결과가 verified receipt에 결합됩니다.",
    detail: "control-plane outcome signer는 vendor receipt signer와 다른 identity를 사용합니다.",
  },
  {
    id: "denial",
    protocolLabel: "POLICY DENY",
    title: "Replay 자동 거절",
    summary: "중복 identifier를 signer 전에 차단합니다.",
    detail: "같은 paymentId 또는 nonce replay는 transactionCreated:false, txSignature:null로 종료되고 paid retry를 보내지 않습니다.",
  },
];

export const createLocalDemoState = (): MissionControlDemoState => ({
  schemaVersion: "1.0",
  adapter: "local-ui-preview",
  evidenceLevel: "pending",
  incidentId: "incident-local-preview-001",
  environmentLabel: "LOCAL SIMULATION",
  dependency: {
    label: "primary-rpc",
    state: "unhealthy",
    healthDetail: "3/3 probe failed · fixture",
  },
  cluster: {
    label: "Solana Devnet",
    caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  },
  killSwitch: {
    engaged: false,
    label: "STANDBY · operator route only",
  },
  mandate: {
    status: "active",
    incidentCapUsdc: "0.050000",
    perTransactionCapUsdc: "0.020000",
    durationMinutes: 10,
    asset: "USDC",
    capability: "solana-rpc-health",
    remainingUsdc: "0.050000",
  },
  modelDecision: {
    provider: "Gemini",
    modeLabel: "SIMULATED ADAPTER",
    selectedOfferId: "offer-rpc-burst-v1",
    counterfactualOfferId: "offer-rpc-economy-v1",
    capability: "solana-rpc-health",
    rationale:
      "오류율 38%와 p95 2.8초 조건에서는 12초 이내 복구가 예산 범위 안의 최저 위험 선택입니다.",
    counterfactualResult:
      "오류율이 낮고 latency 여유가 있는 fixture에서는 offer-rpc-economy-v1로 선택이 바뀝니다.",
  },
  offers: [
    {
      offerId: "offer-rpc-economy-v1",
      revision: "sha256-bound · v1",
      capability: "solana-rpc-health",
      vendorLabel: "Vendor Agent / Economy",
      priceUsdc: "0.012000",
      estimatedRecoverySeconds: 32,
      latencyP95Ms: 840,
      expiresAtLabel: "+10 min fixture",
      signedOfferVerified: false,
      selected: false,
    },
    {
      offerId: "offer-rpc-burst-v1",
      revision: "sha256-bound · v1",
      capability: "solana-rpc-health",
      vendorLabel: "Vendor Agent / Burst",
      priceUsdc: "0.018000",
      estimatedRecoverySeconds: 12,
      latencyP95Ms: 310,
      expiresAtLabel: "+10 min fixture",
      signedOfferVerified: false,
      selected: true,
    },
  ],
  timeline: TIMELINE_COPY.map((step) => ({
    ...step,
    timeLabel: "--:--.---",
    state: "waiting",
  })),
  paymentEvidence: { level: "pending" },
  denials: [
    {
      id: "deny-over-cap-fixture",
      rule: "perTransactionCap",
      title: "Over-cap 자동 거절",
      attemptedAt: "LOCAL FIXTURE",
      requestedValue: "0.021000 USDC",
      policyValue: "≤ 0.020000 USDC",
      transactionCreated: false,
      txSignature: null,
      evidenceLevel: "local-simulated",
    },
    {
      id: "deny-replay-fixture",
      rule: "nonceReplay",
      title: "Nonce replay 자동 거절",
      attemptedAt: "LOCAL FIXTURE",
      requestedValue: "nonce: already-seen",
      policyValue: "nonce: unseen only",
      transactionCreated: false,
      txSignature: null,
      evidenceLevel: "local-simulated",
    },
  ],
});

/** Capture revisions may execute the separately authenticated live route, but
 * this initial dashboard contains no promoted payment proof. Keep its stage
 * visible and distinct from both the local fixture and final verified replay. */
export const createLiveUnverifiedDemoState = (): MissionControlDemoState => ({
  ...createLocalDemoState(),
  adapter: "control-plane-api",
  evidenceLevel: "live-unverified",
  environmentLabel: "LIVE UNVERIFIED",
  dependency: {
    label: "primary-rpc",
    state: "unhealthy",
    healthDetail: "capture revision · evidence not promoted",
  },
  killSwitch: {
    engaged: false,
    label: "STANDBY · operator-authenticated route",
  },
  paymentEvidence: { level: "pending" },
});

export const applyTimelineProgress = (
  state: MissionControlDemoState,
  activeIndex: number,
): MissionControlDemoState => {
  const timeline = state.timeline.map((step, index): MissionTimelineStep => {
    if (index < activeIndex) {
      return {
        ...step,
        state: step.id === "denial"
          ? "denied"
          : state.evidenceLevel === "devnet-verified"
            ? "devnet-verified"
            : "local-simulated",
        timeLabel:
          state.evidenceLevel === "devnet-verified"
            ? step.timeLabel
            : `LOCAL · ${String(index + 1).padStart(2, "0")}`,
      };
    }

    if (index === activeIndex) {
      return {
        ...step,
        state: "running",
        timeLabel:
          state.evidenceLevel === "devnet-verified"
            ? step.timeLabel
            : `LOCAL · ${String(index + 1).padStart(2, "0")}`,
      };
    }

    return { ...step, state: "waiting", timeLabel: "--:--.---" };
  });

  const completed = activeIndex >= timeline.length;
  const paymentEvidence = state.paymentEvidence;
  const budgetBaseUnits = paymentEvidence.level === "devnet-verified"
    ? completed
      ? paymentEvidence.budgetAfterBaseUnits
      : paymentEvidence.budgetBeforeBaseUnits
    : null;
  const formatUsdc = (baseUnits: string): string => {
    const padded = baseUnits.padStart(7, "0");
    return `${padded.slice(0, -6).replace(/^0+(?=\d)/u, "")}.${padded.slice(-6)}`;
  };

  return {
    ...state,
    evidenceLevel:
      state.evidenceLevel === "devnet-verified"
        ? "devnet-verified"
        : state.evidenceLevel === "live-unverified"
          ? "live-unverified"
          : "local-simulated",
    dependency: {
      ...state.dependency,
      state: completed ? "healthy" : "recovering",
      healthDetail: completed
        ? state.evidenceLevel === "devnet-verified"
          ? "signed outcome · independently verified"
          : "local recovery preview · Devnet evidence pending"
        : "orchestration preview running",
    },
    mandate: budgetBaseUnits === null
      ? state.mandate
      : { ...state.mandate, remainingUsdc: formatUsdc(budgetBaseUnits) },
    timeline,
  };
};
