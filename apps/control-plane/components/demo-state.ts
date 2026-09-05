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
  quotedLatencyMs?: number;
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
  recoveryStartedAt: string;
  recoveredAt: string;
  recoveryScope: "route-activation";
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
    baselineConditions?: string;
    counterfactualConditions?: string;
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
    title: "기본 RPC 장애",
    summary: "상태 확인 요청이 연속으로 실패했습니다.",
    detail: "테스트 데이터로 장애 신호를 재현합니다. 고객 식별자나 인증 정보는 포함하지 않습니다.",
  },
  {
    id: "gemini",
    protocolLabel: "GEMINI",
    title: "장애 진단과 필요 기능 제안",
    summary: "허용된 장애 신호를 바탕으로 solana-rpc-health 기능을 제안합니다.",
    detail: "모델은 제공된 offerId만 비교합니다. 금액을 계산하거나 정책을 바꿀 수 없으며, 키 접근이나 트랜잭션 서명 권한도 없습니다.",
  },
  {
    id: "a2a",
    protocolLabel: "A2A",
    title: "Agent Card와 두 견적 확인",
    summary: "별도로 실행되는 공급자 에이전트에서 변경할 수 없는 서명 견적 두 개를 받습니다.",
    detail: "견적 설명을 지시사항으로 신뢰하지 않습니다. 모든 견적은 정해진 스키마와 서명 검증을 통과해야 합니다.",
  },
  {
    id: "challenge",
    protocolLabel: "HTTP 402",
    title: "Payment Required",
    summary: "유료 복구 API가 x402 결제 조건을 반환합니다.",
    detail: "PAYMENT-REQUIRED 헤더와 요청 지문을 검증하는 단계입니다. 이 미리보기에서는 실제 결제 조건을 요청하지 않습니다.",
  },
  {
    id: "policy",
    protocolLabel: "POLICY / SIGN",
    title: "예산 예약과 자동 결제 서명",
    summary: "결제 실행기가 저장소의 원본 정책을 다시 확인합니다.",
    detail: "애플리케이션 정책과 별도 저잔액 지갑으로 지출을 제한합니다. 결제 실행기는 결제 데이터에만 서명하며 온체인 전송을 먼저 실행하지 않습니다.",
  },
  {
    id: "retry",
    protocolLabel: "PAID RETRY",
    title: "PAYMENT-SIGNATURE 재요청",
    summary: "사람의 건별 승인 없이 같은 요청을 재시도합니다.",
    detail: "건별 승인이나 지갑 팝업 없이, 사전에 부여한 권한과 정책 조건에 따라 요청을 다시 보냅니다.",
  },
  {
    id: "settle",
    protocolLabel: "VERIFY / SETTLE",
    title: "공급자의 중복 처리 방지",
    summary: "paymentId의 처리 권한을 원자적으로 확보한 뒤 결제를 검증하고 정산합니다.",
    detail: "정산이 확인된 뒤에만 리소스를 반환합니다. 정산 결과가 불확실하면 재결제하지 않고 기존 거래 상태를 확인합니다.",
  },
  {
    id: "resource",
    protocolLabel: "HTTP 200",
    title: "복구 리소스 제공",
    summary: "정산 확인 후 서명 영수증과 함께 리소스를 반환합니다.",
    detail: "영수증은 견적, 결제 조건, 요청, 트랜잭션, 응답, 장애 기록이 서로 일치함을 증명해야 합니다.",
  },
  {
    id: "recovery",
    protocolLabel: "RECOVERY",
    title: "복구 검증 단계",
    summary: "서명 영수증과 결과를 연결하는 단계입니다. 예시 재생은 실제 복구 증거가 아닙니다.",
    detail: "실행 결과 서명자와 공급자의 영수증 서명자는 서로 다른 계정을 사용합니다.",
  },
  {
    id: "denial",
    protocolLabel: "POLICY DENY",
    title: "중복 요청 자동 거절",
    summary: "서명 전에 식별자의 중복 여부를 확인합니다.",
    detail: "같은 paymentId나 nonce를 재사용하면 transactionCreated:false, txSignature:null로 거절합니다. 결제 요청을 다시 보내지 않습니다.",
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
      "오류율 38%, p95 응답 시간 2.8초를 가정한 예시에서는 예산 한도 안의 빠른 복구 옵션을 선택합니다.",
    counterfactualResult:
      "오류율이 낮고 응답 시간을 더 허용할 수 있는 예시에서는 저렴한 offer-rpc-economy-v1을 선택합니다.",
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
      title: "한도 초과 자동 거절",
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
      title: "중복 nonce 자동 거절",
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
