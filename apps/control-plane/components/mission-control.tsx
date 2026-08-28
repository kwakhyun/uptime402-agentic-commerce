"use client";

import Image from "next/image";
import {
  ArrowRight,
  ArrowSquareOut,
  CaretDown,
  Check,
  CheckCircle,
  CircleNotch,
  Code,
  FileText,
  Heartbeat,
  LockKey,
  Pause,
  Play,
  Receipt,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyTimelineProgress,
  type MissionControlDemoState,
  type MissionTimelineStep,
  type VerifiedPaymentEvidenceView,
} from "./demo-state";
import { LiveOperatorTrigger } from "./live-operator-trigger";
import type { LiveOperatorUiConfig } from "../src/live-ui-contract";

interface MissionControlProps {
  initialState: MissionControlDemoState;
  liveOperatorConfig: LiveOperatorUiConfig;
}

const STEP_INTERVAL_MS = 1_000;

const RECOVERY_PHASES = [
  { id: 1, label: "장애 감지", protocol: "Incident" },
  { id: 2, label: "옵션 판단", protocol: "Gemini · A2A" },
  { id: 3, label: "정책 결제", protocol: "Policy · x402" },
  { id: 4, label: "복구 검증", protocol: "Receipt" },
] as const;

const statusLabel: Record<MissionTimelineStep["state"], string> = {
  waiting: "대기",
  running: "확인 중",
  "local-simulated": "로컬 미리보기",
  "devnet-verified": "검증됨",
  denied: "자동 차단",
};

function compactDecimal(value: string): string {
  return value.replace(/0+$/u, "").replace(/\.$/u, "");
}

function EvidenceRows({
  rows,
}: {
  rows: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <dl className="evidence-list">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd><code>{value}</code></dd>
        </div>
      ))}
    </dl>
  );
}

function VerifiedEvidence({ evidence }: { evidence: VerifiedPaymentEvidenceView }) {
  const paymentRows: ReadonlyArray<readonly [string, string]> = [
    ["Payment ID", evidence.paymentId],
    ["Run binding hash", evidence.runBindingHash],
    ["Offer ID", evidence.offerId],
    ["CAIP-2 network", evidence.network],
    ["Genesis hash", evidence.genesisHash],
    ["SDK network ID", evidence.sdkNetworkId],
    ["USDC mint", evidence.mint],
    ["Amount", `${evidence.amountUsdc} USDC / ${evidence.amountBaseUnits} base units`],
    ["Budget", `${evidence.budgetBeforeBaseUnits} → ${evidence.budgetAfterBaseUnits} base units`],
    ["Payer owner", evidence.payerOwner],
    ["Payee owner", evidence.payeeOwner],
    ["Token delta", `${evidence.payerTokenDeltaBaseUnits} / +${evidence.payeeTokenDeltaBaseUnits.replace(/^\+/u, "")}`],
    ["Transaction signature", evidence.transactionSignature],
    ["Confirmation", `${evidence.confirmationStatus} · slot ${evidence.confirmationSlot}`],
  ];
  const requestRows: ReadonlyArray<readonly [string, string]> = [
    ["Resource URL", evidence.resourceUrl],
    ["Operation ID", evidence.operationId],
    ["Canonical body hash", evidence.canonicalBodyHash],
    ["Execution policy hash", evidence.executionPolicyHash],
    ["Challenge hash", evidence.challengeHash],
    ["Request fingerprint", evidence.requestFingerprint],
    ["Resource response hash", evidence.resourceResponseHash],
    ["PAYMENT-REQUIRED hash", evidence.paymentRequiredHeaderHash],
    ["PAYMENT-SIGNATURE hash", evidence.paymentSignatureHeaderHash],
    ["PAYMENT-RESPONSE hash", evidence.paymentResponseHeaderHash],
  ];
  const receiptRows: ReadonlyArray<readonly [string, string]> = [
    ["Receipt envelope hash", evidence.fulfillmentReceiptHash],
    ["Receipt signer", `${evidence.receiptSignerPublicKey} · ${evidence.receiptKeyId}`],
    ["Receipt signature", evidence.receiptSignature],
    ["Bound incident", evidence.receiptBindings.incidentId],
    ["Bound offer", evidence.receiptBindings.offerId],
    ["Bound payment", evidence.receiptBindings.paymentId],
    ["Bound policy", evidence.receiptBindings.executionPolicyHash],
    ["Bound challenge", evidence.receiptBindings.challengeHash],
    ["Bound request", evidence.receiptBindings.requestFingerprint],
    ["Bound transaction", evidence.receiptBindings.transactionSignature],
    ["Bound response", evidence.receiptBindings.resourceResponseHash],
    ["Outcome signer", `${evidence.outcomeSignerPublicKey} · ${evidence.outcomeKeyId}`],
    ["Outcome signature", evidence.outcomeSignature],
    ["Health probe hash", evidence.healthProbeHash],
    ["Outcome artifact hash", evidence.outcomeArtifactHash],
  ];

  return (
    <div className="verified-evidence">
      <div className="verified-evidence__summary">
        <CheckCircle size={20} weight="fill" aria-hidden="true" />
        <div>
          <strong>Devnet 결제와 복구 결과 검증 완료</strong>
          <span>
            receiptVerified: {String(evidence.receiptVerified)} · outcomeVerified: {String(evidence.outcomeVerified)}
          </span>
        </div>
      </div>

      <details className="evidence-subsection">
        <summary>온체인 결제와 계정 변화 <CaretDown size={16} aria-hidden="true" /></summary>
        <EvidenceRows rows={paymentRows} />
        <div className="token-delta-list">
          {evidence.tokenAccountDeltas.map((delta) => (
            <div key={delta.tokenAccount}>
              <span>Token account {delta.accountIndex}</span>
              <code>{delta.tokenAccount}</code>
              <small>{delta.preAmountBaseUnits} → {delta.postAmountBaseUnits} · Δ {delta.deltaBaseUnits}</small>
            </div>
          ))}
        </div>
      </details>

      <details className="evidence-subsection">
        <summary>x402 요청 바인딩 <CaretDown size={16} aria-hidden="true" /></summary>
        <EvidenceRows rows={requestRows} />
        <div className="x402-trace">
          {evidence.x402Headers.map((header) => (
            <article key={header.name}>
              <strong>{header.status} · {header.name}</strong>
              <time>{header.capturedAt}</time>
              <code>{header.value}</code>
            </article>
          ))}
        </div>
      </details>

      <details className="evidence-subsection">
        <summary>정책 reserve → commit <CaretDown size={16} aria-hidden="true" /></summary>
        <EvidenceRows rows={[
          ["Reservation ID", evidence.reservationId],
          ["State history", evidence.reservationStateHistory.join(" → ")],
        ]} />
        <ol className="policy-rule-list">
          {evidence.policyRules.map((rule, index) => (
            <li key={`${rule.rule}-${index}`}>
              <Check size={15} weight="bold" aria-hidden="true" />
              <code>{rule.rule}</code>
              <span>expected {String(rule.expected)} · actual {String(rule.actual)}</span>
            </li>
          ))}
        </ol>
      </details>

      <details className="evidence-subsection">
        <summary>서명 영수증과 outcome binding <CaretDown size={16} aria-hidden="true" /></summary>
        <EvidenceRows rows={receiptRows} />
      </details>
    </div>
  );
}

function phaseForStep(stepId: MissionTimelineStep["id"]): number {
  if (stepId === "incident") return 1;
  if (stepId === "gemini" || stepId === "a2a") return 2;
  if (["challenge", "policy", "retry", "settle"].includes(stepId)) return 3;
  return 4;
}

export function MissionControl({ initialState, liveOperatorConfig }: MissionControlProps) {
  const [demoState, setDemoState] = useState(initialState);
  const [runStarted, setRunStarted] = useState(false);
  const [runPaused, setRunPaused] = useState(false);
  const [decisionView, setDecisionView] = useState<"baseline" | "counterfactual">("baseline");
  const [selectedStepId, setSelectedStepId] = useState<MissionTimelineStep["id"]>(
    initialState.timeline[0]?.id ?? "incident",
  );
  const [developerOpen, setDeveloperOpen] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressRef = useRef(0);

  const clearPlaybackTimer = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
  }, []);

  const setTimelineProgress = useCallback((nextProgress: number) => {
    const timelineLength = initialState.timeline.length;
    const boundedProgress = Math.max(0, Math.min(nextProgress, timelineLength));
    progressRef.current = boundedProgress;
    setDemoState(applyTimelineProgress(initialState, boundedProgress));
    const nextStep = initialState.timeline[
      Math.min(boundedProgress, Math.max(timelineLength - 1, 0))
    ];
    if (nextStep) setSelectedStepId(nextStep.id);
  }, [initialState]);

  const beginPlayback = useCallback(() => {
    clearPlaybackTimer();
    setRunPaused(false);
    intervalRef.current = setInterval(() => {
      const next = progressRef.current + 1;
      setTimelineProgress(next);
      if (next >= initialState.timeline.length) clearPlaybackTimer();
    }, STEP_INTERVAL_MS);
  }, [clearPlaybackTimer, initialState.timeline.length, setTimelineProgress]);

  useEffect(() => () => clearPlaybackTimer(), [clearPlaybackTimer]);

  const completionCount = demoState.timeline.filter((step) =>
    ["local-simulated", "devnet-verified", "denied"].includes(step.state),
  ).length;
  const runComplete = runStarted && completionCount === demoState.timeline.length;
  const verifiedEvidence = demoState.paymentEvidence.level === "devnet-verified"
    ? demoState.paymentEvidence
    : null;
  const devnetVerified = verifiedEvidence !== null;
  const liveUnverified = demoState.evidenceLevel === "live-unverified";
  const paidAmountLabel = verifiedEvidence ? compactDecimal(verifiedEvidence.amountUsdc) : null;
  const recoverySecondsLabel = verifiedEvidence
    ? (verifiedEvidence.recoveryTimeMs / 1_000).toFixed(3)
    : null;
  const displayedOfferId = decisionView === "baseline"
    ? demoState.modelDecision.selectedOfferId
    : demoState.modelDecision.counterfactualOfferId;
  const currentPhase = runStarted ? phaseForStep(selectedStepId) : 0;
  const selectedStep = demoState.timeline.find((step) => step.id === selectedStepId);
  const incidentTimeLabel = initialState.timeline.find((step) => step.id === "incident")?.timeLabel ?? "--:--.---";
  const recoveredTimeLabel = initialState.timeline.find((step) => step.id === "recovery")?.timeLabel ?? "--:--.---";
  const overCapDenial = demoState.denials.find((denial) => denial.rule === "perTransactionCap");
  const replayDenial = demoState.denials.find((denial) => denial.rule !== "perTransactionCap");
  const replayProgressPercent = !runStarted
    ? 0
    : runComplete
      ? 100
      : Math.round((completionCount / Math.max(demoState.timeline.length, 1)) * 100);

  const phaseState = (phase: number): "waiting" | "active" | "complete" => {
    if (!runStarted) return "waiting";
    if (runComplete || currentPhase > phase) return "complete";
    return currentPhase === phase ? "active" : "waiting";
  };

  const phaseClass = (phase: number): string => {
    const state = phaseState(phase);
    if (state === "complete") return " is-complete";
    return state === "active" ? " is-active" : "";
  };

  const startPlayback = () => {
    clearPlaybackTimer();
    setRunStarted(true);
    setDecisionView("baseline");
    setTimelineProgress(0);
    beginPlayback();
  };

  const togglePlayback = () => {
    if (!runStarted || runComplete) {
      startPlayback();
      return;
    }
    if (runPaused) {
      beginPlayback();
      return;
    }
    clearPlaybackTimer();
    setRunPaused(true);
  };

  const playbackLabel = runComplete
    ? "처음부터 다시 보기"
    : runPaused
      ? "재생 계속"
      : runStarted
        ? "재생 일시정지"
        : "실행 과정 재생";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#recovery-flow">복구 과정으로 건너뛰기</a>

      <header className="app-header">
        <a className="brand" href="#overview" aria-label="Uptime402 홈">
          <Image src="/icon.svg" width={36} height={36} alt="" priority />
          <span>Uptime402</span>
        </a>
        <nav aria-label="페이지 섹션">
          <a href="#overview">개요</a>
          <a href="#recovery-flow">복구 과정</a>
          <a href="#developer-evidence">검증 증거</a>
        </nav>
        <span className={`header-status ${devnetVerified ? "is-verified" : "is-unverified"}`}>
          {devnetVerified ? <CheckCircle size={17} weight="fill" aria-hidden="true" /> : <WarningCircle size={17} weight="fill" aria-hidden="true" />}
          {devnetVerified ? "복구 완료" : demoState.environmentLabel}
        </span>
      </header>

      <main className="recovery-report">
        <section className="report-hero" id="overview" aria-labelledby="report-title">
          <h1 id="report-title">
            {devnetVerified ? (
              <>장애를 감지하고 <strong>{recoverySecondsLabel}초</strong> 만에 복구했습니다</>
            ) : liveUnverified ? (
              <>장애 복구 증거를 <strong>수집 중</strong>입니다</>
            ) : (
              <>안전한 자동 복구 흐름을 <strong>미리 확인</strong>합니다</>
            )}
          </h1>
          <p className="report-summary">
            {devnetVerified
              ? `Gemini가 두 복구 옵션을 비교하고, 설정된 정책 안에서 ${paidAmountLabel} USDC를 자동 결제해 서비스를 정상화했습니다.`
              : "Gemini 진단, A2A 견적 비교, 정책 판정과 x402 결제 흐름을 네 단계로 확인할 수 있습니다."}
          </p>
          <div className="hero-action-group">
            <button
              className={`replay-button${!runStarted ? " is-ready" : ""}`}
              type="button"
              onClick={togglePlayback}
              aria-pressed={runStarted && !runPaused && !runComplete}
            >
              {runStarted && !runPaused && !runComplete
                ? <Pause size={19} weight="fill" aria-hidden="true" />
                : <Play size={19} weight="fill" aria-hidden="true" />}
              <span>{playbackLabel}</span>
            </button>
            <span className="read-only-note">
              <LockKey size={16} aria-hidden="true" />
              {devnetVerified ? "읽기 전용 · 새 결제 없음" : liveUnverified ? "LIVE UNVERIFIED · 검증 전" : "로컬 미리보기 · 결제 없음"}
            </span>
          </div>
          <div className="playback-status" role="status" aria-live="polite">
            {runStarted ? (
              <>
                <span>{runComplete ? "확인 완료" : `${Math.min(completionCount + 1, demoState.timeline.length)} / ${demoState.timeline.length}`}</span>
                <strong>{runComplete ? "자동 복구의 판단과 증거를 모두 확인했습니다." : selectedStep?.title}</strong>
              </>
            ) : (
              <><span>안내</span><strong>재생 버튼을 누르면 실제 기록이 단계별로 강조됩니다.</strong></>
            )}
          </div>
        </section>

        <section
          className={`replay-progress${runComplete ? " is-complete" : ""}`}
          aria-labelledby="replay-progress-title"
          aria-busy={runStarted && !runPaused && !runComplete}
        >
          <div className="replay-progress__header">
            <div>
              <span>{runStarted ? `현재 ${Math.max(currentPhase, 1)} / 4단계` : "4단계 자동 복구"}</span>
              <strong id="replay-progress-title">
                {!runStarted
                  ? "재생을 시작하면 판단과 결제 과정을 순서대로 보여드립니다."
                  : runComplete
                    ? "자동 복구 기록을 모두 확인했습니다."
                    : runPaused
                      ? `일시정지 · ${selectedStep?.title ?? "복구 기록"}`
                      : selectedStep?.title}
              </strong>
            </div>
            <output aria-label="재생 진행률">{replayProgressPercent}%</output>
          </div>
          <div
            className="replay-progress__track"
            role="progressbar"
            aria-label="자동 복구 재생 진행률"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={replayProgressPercent}
          >
            <span style={{ width: `${replayProgressPercent}%` }} />
          </div>
          <ol className="replay-progress__stages" aria-label="자동 복구 단계">
            {RECOVERY_PHASES.map((phase) => {
              const state = phaseState(phase.id);
              const status = state === "complete"
                ? "완료"
                : state === "active"
                  ? runPaused ? "일시정지" : "진행 중"
                  : "대기";
              return (
                <li
                  className={`replay-progress__stage is-${state}`}
                  aria-current={state === "active" ? "step" : undefined}
                  key={phase.id}
                >
                  <span className="replay-progress__marker" aria-hidden="true">
                    {state === "complete" ? (
                      <Check size={15} weight="bold" />
                    ) : state === "active" ? (
                      runPaused
                        ? <Pause size={13} weight="fill" />
                        : <CircleNotch className="stage-spinner" size={16} weight="bold" />
                    ) : (
                      phase.id
                    )}
                  </span>
                  <span>
                    <small>{phase.protocol}</small>
                    <strong>{phase.label}</strong>
                  </span>
                  <em>{status}</em>
                </li>
              );
            })}
          </ol>
        </section>

        <section className="health-transition" aria-label="서비스 상태 변화">
          <div className="health-state health-state--before">
            <WarningCircle size={22} weight="fill" aria-hidden="true" />
            <div><span>장애 감지</span><strong>{demoState.dependency.label}</strong></div>
            <small>health probe 실패</small>
          </div>
          <ArrowRight className="health-arrow" size={22} aria-hidden="true" />
          <div className="health-state health-state--after">
            <CheckCircle size={22} weight="fill" aria-hidden="true" />
            <div><span>복구 완료</span><strong>service healthy</strong></div>
            <small>{devnetVerified ? `${recoverySecondsLabel}초` : "preview"}</small>
          </div>
          <dl className="health-timing">
            <div><dt>장애 기록</dt><dd>{incidentTimeLabel}</dd></div>
            <div><dt>복구 기록</dt><dd>{recoveredTimeLabel}</dd></div>
            <div><dt>총 소요 시간</dt><dd>{devnetVerified ? `${recoverySecondsLabel}초` : "evidence pending"}</dd></div>
          </dl>
        </section>

        <ol className="recovery-sections" id="recovery-flow">
          <li className={`recovery-section${phaseClass(1)}`}>
            <div className="section-index" aria-hidden="true">01</div>
            <div className="section-title">
              <span>Incident</span>
              <h2>장애를 감지했습니다</h2>
            </div>
            <div className="section-content incident-content">
              <div className="incident-signal">
                <Heartbeat size={22} aria-hidden="true" />
                <div>
                  <strong>Primary RPC health check 실패</strong>
                  <p>allowlist로 정제된 telemetry만 Gemini에 전달했습니다.</p>
                </div>
              </div>
              <dl className="compact-facts">
                <div><dt>Incident</dt><dd>{demoState.incidentId}</dd></div>
                <div><dt>Capability</dt><dd>{demoState.mandate.capability}</dd></div>
              </dl>
            </div>
          </li>

          <li className={`recovery-section${phaseClass(2)}`}>
            <div className="section-index" aria-hidden="true">02</div>
            <div className="section-title">
              <span>Gemini + A2A</span>
              <h2>Gemini가 두 복구 옵션을 비교했습니다</h2>
            </div>
            <div className="section-content offer-comparison">
              <div className="comparison-toolbar" aria-label="Gemini 판단 조건">
                <div>
                  <ShieldCheck size={18} aria-hidden="true" />
                  <span>{demoState.modelDecision.modeLabel}</span>
                </div>
                <div className="condition-switch">
                  <button
                    type="button"
                    className={decisionView === "baseline" ? "is-selected" : ""}
                    onClick={() => setDecisionView("baseline")}
                    aria-pressed={decisionView === "baseline"}
                  >실제 조건</button>
                  <button
                    type="button"
                    className={decisionView === "counterfactual" ? "is-selected" : ""}
                    onClick={() => setDecisionView("counterfactual")}
                    aria-pressed={decisionView === "counterfactual"}
                  >반대 조건</button>
                </div>
              </div>
              <div className="offer-table" role="table" aria-label="A2A 복구 견적 비교">
                <div className="offer-table__head" role="row">
                  <span role="columnheader">복구 옵션</span>
                  <span role="columnheader">비용</span>
                  <span role="columnheader">복구 정보</span>
                  <span role="columnheader">판단</span>
                </div>
                {demoState.offers.map((offer) => {
                  const selected = offer.offerId === displayedOfferId;
                  return (
                    <div className={`offer-row${selected ? " is-selected" : ""}`} role="row" key={offer.offerId}>
                      <span role="cell"><strong>{offer.offerId}</strong><small>{offer.vendorLabel}</small></span>
                      <span role="cell">{compactDecimal(offer.priceUsdc)} USDC</span>
                      <span role="cell">{offer.estimatedRecoverySeconds === undefined ? "signed offer" : `${offer.estimatedRecoverySeconds}초 예상`}</span>
                      <span role="cell">{selected ? <><Check size={15} weight="bold" aria-hidden="true" /> Gemini 선택</> : "비교 대상"}</span>
                    </div>
                  );
                })}
              </div>
              <p className="decision-note">
                {decisionView === "baseline" ? demoState.modelDecision.rationale : demoState.modelDecision.counterfactualResult}
              </p>
            </div>
          </li>

          <li className={`recovery-section${phaseClass(3)}`}>
            <div className="section-index" aria-hidden="true">03</div>
            <div className="section-title">
              <span>Policy + x402</span>
              <h2>정책이 {paidAmountLabel ?? compactDecimal(demoState.offers.find((offer) => offer.selected)?.priceUsdc ?? "0")} USDC 자동 결제를 허용했습니다</h2>
            </div>
            <div className="section-content policy-content">
              <div className="policy-callout">
                <ShieldCheck size={26} weight="fill" aria-hidden="true" />
                <div>
                  <span>정책 한도 내 자동 실행</span>
                  <strong>{paidAmountLabel ?? "결제 예정"} USDC ≤ {compactDecimal(demoState.mandate.perTransactionCapUsdc)} USDC</strong>
                  <p>최초 mandate 이후 건별 승인이나 지갑 팝업 없이 x402 paid retry를 실행했습니다.</p>
                  <small>한도 초과와 replay 요청은 transaction 생성 전에 자동 차단했습니다.</small>
                </div>
              </div>
            </div>
          </li>

          <li className={`recovery-section${phaseClass(4)}`}>
            <div className="section-index" aria-hidden="true">04</div>
            <div className="section-title">
              <span>Recovery receipt</span>
              <h2>health check와 서명 영수증을 검증했습니다</h2>
            </div>
            <div className="section-content receipt-content">
              <div className="receipt-status">
                <Receipt size={24} aria-hidden="true" />
                <div>
                  <span>Vendor-signed fulfillment receipt</span>
                  <strong>{verifiedEvidence ? "서명 및 request binding 검증 완료" : "검증 evidence 대기"}</strong>
                  <p>결제된 recovery resource를 적용한 뒤 service health가 green으로 전환됐습니다.</p>
                </div>
                {verifiedEvidence ? <CheckCircle size={22} weight="fill" aria-label="검증 완료" /> : <WarningCircle size={22} weight="fill" aria-label="검증 대기" />}
              </div>
              {verifiedEvidence ? (
                <>
                  <div className="receipt-meta">
                    <span>{paidAmountLabel} USDC</span>
                    <span>{demoState.cluster.label}</span>
                    <strong>{verifiedEvidence.confirmationStatus}</strong>
                    <a href={verifiedEvidence.explorerUrl} target="_blank" rel="noopener noreferrer">
                      Solana Explorer <ArrowSquareOut size={15} aria-hidden="true" />
                    </a>
                  </div>
                  <code className="receipt-transaction">Tx · {verifiedEvidence.transactionSignature}</code>
                </>
              ) : null}
            </div>
          </li>
        </ol>

        <details
          className="developer-evidence"
          id="developer-evidence"
          open={developerOpen}
          onToggle={(event) => setDeveloperOpen(event.currentTarget.open)}
        >
          <summary>
            <span className="developer-summary__icon"><Code size={19} aria-hidden="true" /></span>
            <span>
              <strong>개발자용 원본 증거 보기</strong>
              <small>10단계 실행 trace, x402 headers, 정책 판정, 온체인 delta</small>
            </span>
            <CaretDown className="developer-summary__caret" size={18} aria-hidden="true" />
          </summary>
          <div className="developer-evidence__body">
            <section className="trace-panel" aria-labelledby="trace-heading">
              <header>
                <FileText size={20} aria-hidden="true" />
                <div><h3 id="trace-heading">실행 trace</h3><p>읽기 전용 evidence adapter가 표시하는 시간순 기록입니다.</p></div>
              </header>
              <ol className="trace-list">
                {demoState.timeline.map((step, index) => (
                  <li className={step.id === selectedStepId && runStarted && !runComplete ? "is-current" : ""} key={step.id}>
                    <span className="trace-number">{String(index + 1).padStart(2, "0")}</span>
                    <div><span>{step.protocolLabel}</span><strong>{step.title}</strong><p>{step.detail}</p></div>
                    <div className={`trace-status trace-status--${step.state}`}><span>{statusLabel[step.state]}</span><time>{step.timeLabel}</time></div>
                  </li>
                ))}
              </ol>
            </section>

            <section className="denial-panel" aria-labelledby="denial-heading">
              <header><ShieldCheck size={20} aria-hidden="true" /><h3 id="denial-heading">자동 차단 증거</h3></header>
              <div className="denial-grid">
                {[overCapDenial, replayDenial].filter((denial) => denial !== undefined).map((denial) => (
                  <article key={denial.id}>
                    <span>{denial.rule === "perTransactionCap" ? "한도 초과" : "Nonce replay"}</span>
                    <strong>{denial.title}</strong>
                    <code>transactionCreated:{String(denial.transactionCreated)}</code>
                    <code>txSignature:{String(denial.txSignature)}</code>
                    <small>{denial.requestedValue} · policy {denial.policyValue}</small>
                  </article>
                ))}
              </div>
            </section>

            {verifiedEvidence ? <VerifiedEvidence evidence={verifiedEvidence} /> : (
              <section className="unverified-panel">
                <WarningCircle size={22} weight="fill" aria-hidden="true" />
                <div>
                  <strong>{liveUnverified ? "LIVE UNVERIFIED" : "LOCAL SIMULATION"}</strong>
                  <p>검증된 payment-evidence.json과 verification-report.json이 고정되기 전에는 transaction, Explorer, receipt를 verified로 표시하지 않습니다.</p>
                </div>
              </section>
            )}

            {!devnetVerified ? (
              <details className="operator-controls">
                <summary>Capture-only operator controls · Google OIDC <CaretDown size={16} aria-hidden="true" /></summary>
                <LiveOperatorTrigger
                  config={liveOperatorConfig}
                  onRunStarted={() => setDeveloperOpen(true)}
                />
              </details>
            ) : null}
          </div>
        </details>

        <footer className="report-footer">
          <span>Uptime402 · An outage does not wait for procurement.</span>
          <span>{demoState.cluster.label} · {demoState.cluster.caip2}</span>
        </footer>
      </main>
    </div>
  );
}
