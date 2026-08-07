"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyTimelineProgress,
  type ImmutableOfferView,
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

const statusLabel: Record<MissionTimelineStep["state"], string> = {
  waiting: "대기",
  running: "실행 중",
  "local-simulated": "LOCAL PREVIEW",
  "devnet-verified": "DEVNET VERIFIED",
  denied: "DENIED",
};

function RailIcon({ index }: { index: number }) {
  return <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>;
}

function ProtocolMark() {
  return (
    <span className="protocol-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function OfferCard({ offer }: { offer: ImmutableOfferView }) {
  return (
    <article className={`offer-card${offer.selected ? " selected" : ""}`}>
      <header className="offer-card__head">
        <div>
          <p className="eyebrow">IMMUTABLE OFFER</p>
          <h3>{offer.vendorLabel}</h3>
        </div>
        <span className={`offer-chip${offer.selected ? " selected" : ""}`}>
          {offer.selected ? "GEMINI PICK" : "SUPPLIED"}
        </span>
      </header>
      <code className="offer-id">{offer.offerId}</code>
      <dl className="offer-metrics">
        <div>
          <dt>Price</dt>
          <dd>{offer.priceUsdc} USDC</dd>
        </div>
        <div>
          <dt>Recovery</dt>
          <dd>{offer.estimatedRecoverySeconds === undefined ? "signed" : `${offer.estimatedRecoverySeconds}s`}</dd>
        </div>
        <div>
          <dt>p95</dt>
          <dd>{offer.latencyP95Ms === undefined ? "bound" : `${offer.latencyP95Ms}ms`}</dd>
        </div>
      </dl>
      <footer>
        <span>{offer.revision}</span>
        <span>{offer.expiresAtLabel}</span>
        <span className="verification-pending">
          {offer.signedOfferVerified ? "signature verified" : "signature evidence pending"}
        </span>
      </footer>
    </article>
  );
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
          <dd>
            <code>{value}</code>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function VerifiedEvidence({ evidence }: { evidence: VerifiedPaymentEvidenceView }) {
  const evidenceRows: ReadonlyArray<readonly [string, string]> = [
    ["Payment ID", evidence.paymentId],
    ["Run binding hash", evidence.runBindingHash],
    ["Offer ID", evidence.offerId],
    ["CAIP-2 Network", evidence.network],
    ["Genesis hash", evidence.genesisHash],
    ["SDK network ID", evidence.sdkNetworkId],
    ["USDC Mint", evidence.mint],
    ["Amount", `${evidence.amountUsdc} USDC`],
    ["Amount / Base units", evidence.amountBaseUnits],
    ["Budget before", evidence.budgetBeforeBaseUnits],
    ["Budget after", evidence.budgetAfterBaseUnits],
    ["Payer owner", evidence.payerOwner],
    ["Payee owner", evidence.payeeOwner],
    ["Payer token delta", evidence.payerTokenDeltaBaseUnits],
    ["Payee token delta", evidence.payeeTokenDeltaBaseUnits],
    ["Transaction signature", evidence.transactionSignature],
    ["Confirmation status", evidence.confirmationStatus],
    ["Confirmation slot", String(evidence.confirmationSlot)],
    ["Confirmed at", evidence.confirmedAt],
    ["Recovery time", `${evidence.recoveryTimeMs} ms`],
  ];
  const bindingRows: ReadonlyArray<readonly [string, string]> = [
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
  const offerRows: ReadonlyArray<readonly [string, string]> = [
    ["Agent Card URL", evidence.agentCardUrl],
    ["Agent Card hash", evidence.agentCardHash],
    ["Offer signer public key", evidence.offerSignerPublicKey],
    ["Offer signer key ID", evidence.offerSignerKeyId],
    ["Offer signature", evidence.offerSignature],
  ];
  const receiptRows: ReadonlyArray<readonly [string, string]> = [
    ["Receipt envelope hash", evidence.fulfillmentReceiptHash],
    ["Receipt signer public key", evidence.receiptSignerPublicKey],
    ["Receipt signer key ID", evidence.receiptKeyId],
    ["Receipt signature", evidence.receiptSignature],
    ["Bound incident", evidence.receiptBindings.incidentId],
    ["Bound offer", evidence.receiptBindings.offerId],
    ["Bound payment", evidence.receiptBindings.paymentId],
    ["Bound policy", evidence.receiptBindings.executionPolicyHash],
    ["Bound challenge", evidence.receiptBindings.challengeHash],
    ["Bound request", evidence.receiptBindings.requestFingerprint],
    ["Bound transaction", evidence.receiptBindings.transactionSignature],
    ["Bound resource response", evidence.receiptBindings.resourceResponseHash],
  ];
  const outcomeRows: ReadonlyArray<readonly [string, string]> = [
    ["Outcome signer public key", evidence.outcomeSignerPublicKey],
    ["Outcome signer key ID", evidence.outcomeKeyId],
    ["Outcome signature", evidence.outcomeSignature],
    ["Health probe hash", evidence.healthProbeHash],
    ["Outcome artifact hash", evidence.outcomeArtifactHash],
  ];

  return (
    <div className="evidence-verified">
      <div className="verified-banner">
        <span className="pulse-dot" />
        <strong>DEVNET PAYMENT VERIFIED</strong>
        <span>
          receiptVerified: {String(evidence.receiptVerified)} · outcomeVerified:{" "}
          {String(evidence.outcomeVerified)}
        </span>
      </div>
      <EvidenceRows rows={evidenceRows} />
      <details className="evidence-detail-group" open>
        <summary>Offer authority · Agent Card</summary>
        <EvidenceRows rows={offerRows} />
      </details>
      <details className="evidence-detail-group" open>
        <summary>Request · policy · response binding</summary>
        <EvidenceRows rows={bindingRows} />
      </details>
      <details className="evidence-detail-group" open>
        <summary>
          Policy reserve → commit · {evidence.policyRules.length} rules
        </summary>
        <EvidenceRows
          rows={[
            ["Reservation ID", evidence.reservationId],
            ["State history", evidence.reservationStateHistory.join(" → ")],
          ]}
        />
        <ol className="policy-rule-evidence">
          {evidence.policyRules.map((rule, index) => (
            <li key={`${rule.rule}-${index}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <code>{rule.rule}</code>
              <p>
                expected <code>{String(rule.expected)}</code> · actual{" "}
                <code>{String(rule.actual)}</code>
              </p>
              <strong>PASS</strong>
            </li>
          ))}
        </ol>
      </details>
      <details className="evidence-detail-group" open>
        <summary>Vendor receipt · recovery outcome</summary>
        <EvidenceRows rows={[...receiptRows, ...outcomeRows]} />
      </details>
      <details className="token-account-evidence">
        <summary>Token-account pre/post delta</summary>
        <dl className="evidence-list">
          {evidence.tokenAccountDeltas.map((delta) => (
            <div key={delta.tokenAccount}>
              <dt>{delta.tokenAccount}</dt>
              <dd>
                <code>
                  owner {delta.owner} · {delta.preAmountBaseUnits} → {delta.postAmountBaseUnits} · Δ {delta.deltaBaseUnits}
                </code>
              </dd>
            </div>
          ))}
        </dl>
      </details>
      <details className="x402-header-evidence">
        <summary>x402 header trace · signed payload redacted</summary>
        {evidence.x402Headers.map((header) => (
          <article key={header.name}>
            <strong>{header.status} · {header.name}</strong>
            <time>{header.capturedAt}</time>
            <code>{header.value}</code>
          </article>
        ))}
      </details>
      <a
        className="explorer-link"
        href={evidence.explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        Solana Explorer에서 독립 확인 <span aria-hidden="true">↗</span>
      </a>
    </div>
  );
}

export function MissionControl({ initialState, liveOperatorConfig }: MissionControlProps) {
  const [demoState, setDemoState] = useState(initialState);
  const [runStarted, setRunStarted] = useState(false);
  const [runPaused, setRunPaused] = useState(false);
  const [decisionView, setDecisionView] = useState<"baseline" | "counterfactual">("baseline");
  const [selectedStepId, setSelectedStepId] = useState(
    initialState.timeline[0]?.id ?? "incident",
  );
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [protocolOpen, setProtocolOpen] = useState(
    initialState.paymentEvidence.level !== "devnet-verified",
  );
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressRef = useRef(0);
  const protocolDisclosureRef = useRef<HTMLDetailsElement | null>(null);

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
      if (next >= initialState.timeline.length) {
        clearPlaybackTimer();
      }
    }, STEP_INTERVAL_MS);
  }, [clearPlaybackTimer, initialState.timeline.length, setTimelineProgress]);

  const revealProtocolFlow = useCallback(() => {
    setProtocolOpen(true);
    window.requestAnimationFrame(() => {
      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth";
      protocolDisclosureRef.current?.scrollIntoView({ behavior, block: "start" });
    });
  }, []);

  useEffect(() => {
    return () => {
      clearPlaybackTimer();
    };
  }, [clearPlaybackTimer]);

  const selectedStep = demoState.timeline.find((step) => step.id === selectedStepId);

  const completionCount = demoState.timeline.filter(
    (step) =>
      step.state === "local-simulated" ||
      step.state === "devnet-verified" ||
      step.state === "denied",
  ).length;
  const runComplete = runStarted && completionCount === demoState.timeline.length;
  const verifiedEvidence = demoState.paymentEvidence.level === "devnet-verified"
    ? demoState.paymentEvidence
    : null;
  const devnetVerified = verifiedEvidence !== null;
  const liveUnverified = demoState.evidenceLevel === "live-unverified";
  const displayedOfferId = decisionView === "baseline"
    ? demoState.modelDecision.selectedOfferId
    : demoState.modelDecision.counterfactualOfferId;
  const overCapDenial = demoState.denials.find((denial) =>
    denial.rule.toLowerCase().includes("cap"),
  );
  const replayDenial = demoState.denials.find((denial) =>
    /nonce|replay|idempotency/u.test(denial.rule.toLowerCase()),
  );
  const paidAmountLabel = verifiedEvidence?.amountUsdc
    .replace(/0+$/u, "")
    .replace(/\.$/u, "");
  const recoverySecondsLabel = verifiedEvidence
    ? (verifiedEvidence.recoveryTimeMs / 1_000).toFixed(3)
    : null;

  const startIncident = () => {
    revealProtocolFlow();
    clearPlaybackTimer();
    setRunStarted(true);
    setDecisionView("baseline");
    setTimelineProgress(0);
    beginPlayback();
  };

  const togglePlayback = () => {
    if (!runStarted) {
      startIncident();
      return;
    }

    if (runPaused) {
      beginPlayback();
      return;
    }

    clearPlaybackTimer();
    setRunPaused(true);
  };

  const stepPlayback = (direction: -1 | 1) => {
    revealProtocolFlow();
    clearPlaybackTimer();
    setRunStarted(true);
    const nextProgress = Math.max(
      0,
      Math.min(progressRef.current + direction, initialState.timeline.length),
    );
    setTimelineProgress(nextProgress);
    setRunPaused(nextProgress < initialState.timeline.length);
  };

  return (
    <main className="mission-shell">
      <a className="skip-link" href={devnetVerified ? "#verified-result" : "#timeline"}>
        {devnetVerified ? "검증된 복구 결과로 건너뛰기" : "프로토콜 타임라인으로 건너뛰기"}
      </a>

      <header className={`topbar${devnetVerified ? " topbar--replay" : ""}`}>
        <div className="brand-block">
          <div className="brand-lockup">
            <ProtocolMark />
            <div>
              <p className="wordmark">UPTIME<span>402</span></p>
              <p className="tagline">An outage does not wait for procurement.</p>
            </div>
          </div>
          <span className="environment-badge">{demoState.environmentLabel}</span>
        </div>

        {!devnetVerified ? <section className="status-strip" aria-label="운영 상태">
          <article className={`status-tile health-${demoState.dependency.state}`}>
            <p>DEPENDENCY HEALTH</p>
            <strong>
              <span className="pulse-dot" />
              {demoState.dependency.state.toUpperCase()}
            </strong>
            <small>{demoState.dependency.label} · {demoState.dependency.healthDetail}</small>
          </article>
          <article className="status-tile mandate-tile">
            <p>ACTIVE MANDATE</p>
            <strong>{demoState.mandate.incidentCapUsdc} USDC / incident</strong>
            <small>
              tx ≤ {demoState.mandate.perTransactionCapUsdc} · {demoState.mandate.durationMinutes === null ? "versioned mandate" : `${demoState.mandate.durationMinutes} min`}
            </small>
          </article>
          <article className="status-tile budget-tile">
            <p>REMAINING BUDGET</p>
            <strong>{demoState.mandate.remainingUsdc} USDC</strong>
            <small>
              {devnetVerified
                ? "verified evidence adapter"
                : liveUnverified
                  ? "capture runtime · evidence not promoted"
                : "authoritative local fixture · not committed"}
            </small>
          </article>
          <article className="status-tile network-tile">
            <p>CLUSTER</p>
            <strong>{demoState.cluster.label}</strong>
            <small>{demoState.cluster.caip2}</small>
          </article>
          <article className="status-tile kill-tile">
            <p>KILL SWITCH</p>
            <strong>{demoState.killSwitch.engaged ? "ENGAGED" : "STANDBY"}</strong>
            <small>{demoState.killSwitch.label}</small>
          </article>
        </section> : null}

        <div className="topbar-actions">
          <div
            className={`automation-note${!runStarted ? " is-guided" : ""}`}
            id={devnetVerified ? "replay-guide" : undefined}
          >
            <span className="automation-note__step" aria-hidden="true">
              {runComplete ? "DONE" : runPaused ? "PAUSE" : runStarted ? "PLAY" : "NEXT"}
            </span>
            <span>
              {devnetVerified ? (
                runComplete ? (
                  <>판단 완료 · 자동 결제, 정책 준수, 복구 결과가 모두 <strong>PASS</strong></>
                ) : runPaused ? (
                  <>재생 일시정지 · 이전/다음으로 증거를 직접 확인할 수 있습니다</>
                ) : runStarted ? (
                  <>현재 cyan 단계가 결제·복구 순서대로 이동합니다</>
                ) : (
                  <>버튼을 눌러 <strong>10-step 증거 흐름</strong>을 확인하세요</>
                )
              ) : liveUnverified ? (
                <>LIVE capture · 결과는 verifier 전까지 미검증</>
              ) : (
                <>목표 계약 · mandate 이후 건별 승인 없음</>
              )}
            </span>
          </div>
          <button
            className={`trigger-button${!runStarted ? " needs-attention" : ""}`}
            type="button"
            onClick={startIncident}
            disabled={runStarted && !runComplete}
            aria-describedby={devnetVerified ? "replay-guide" : undefined}
          >
            <span className="trigger-button__icon" aria-hidden="true">↯</span>
            <span>
              <strong>
                {runComplete
                  ? devnetVerified
                    ? "검증된 trace 다시 재생"
                    : "로컬 복구 preview 완료"
                  : runPaused
                    ? "증거 흐름 일시정지"
                    : runStarted
                      ? "자동 복구 시퀀스 실행 중"
                      : devnetVerified
                        ? "검증된 trace 보기"
                        : "로컬 incident preview"}
              </strong>
              <small>
                {runComplete
                  ? "READ-ONLY · 새 결제 없이 반복 가능"
                  : runStarted
                    ? `${completionCount}/${demoState.timeline.length} ${devnetVerified ? "verified events" : "local preview"}`
                    : devnetVerified
                      ? "READ-ONLY · 새 결제 없음"
                      : "NO NETWORK · NO PAYMENT"}
              </small>
            </span>
          </button>
        </div>
      </header>

      {verifiedEvidence ? (
        <section className="recovery-hero" id="verified-result" aria-labelledby="verified-result-heading">
          <div className="recovery-hero__copy">
            <div className="hero-entry-guide">
              <span>01 · 먼저 확인</span>
              <strong>결론 → 판단 신호 → 증거 흐름 순서로 보세요</strong>
            </div>
            <p className="eyebrow">AUTONOMOUS RECOVERY · VERIFIED DEVNET EVIDENCE</p>
            <h1 id="verified-result-heading">
              Gemini가 정책 한도 안에서 <em>{paidAmountLabel} USDC</em>를 자동 결제해 장애를 복구했습니다.
            </h1>
            <p>
              운영자가 최초 mandate를 설정한 뒤 결제 승인 클릭과 wallet popup 없이,
              A2A offer 선택부터 x402 settlement와 health recovery까지 자동 실행했습니다.
            </p>
            <div className="recovery-context" aria-label="검증 컨텍스트">
              <span>READ-ONLY EVIDENCE REPLAY</span>
              <span>{demoState.incidentId}</span>
              <span>{demoState.cluster.label}</span>
            </div>
          </div>

          <section className="outcome-panel" aria-labelledby="judge-guide-heading">
            <header className="judge-guide">
              <span>JUDGE CHECK · 3 SIGNALS</span>
              <strong id="judge-guide-heading">자동 결제 · 정책 준수 · 복구 완료를 확인하세요</strong>
              <small>세 조건 모두 실제 Devnet evidence에 bind되어야 PASS입니다.</small>
            </header>
            <div className="outcome-metrics" aria-label="핵심 복구 결과">
              <article>
                <span>AUTOMATIC PAYMENT</span>
                <strong>{paidAmountLabel} USDC</strong>
                <small>Solana Devnet · finalized</small>
              </article>
              <article>
                <span>PER-PAYMENT APPROVAL</span>
                <strong>0회</strong>
                <small>최초 mandate 이후</small>
              </article>
              <article>
                <span>RECOVERY TIME</span>
                <strong>{recoverySecondsLabel}초</strong>
                <small>degraded → healthy</small>
              </article>
              <article>
                <span>POLICY RESULT</span>
                <strong>IN POLICY</strong>
                <small>{verifiedEvidence.amountBaseUnits} ≤ 20000 base units</small>
              </article>
            </div>
          </section>

          <ol className="recovery-path" aria-label="자동 복구 핵심 경로">
            <li><span>01</span><strong>Gemini 진단</strong><small>2 offers 비교</small></li>
            <li><span>02</span><strong>A2A 선택</strong><small>{verifiedEvidence.offerId}</small></li>
            <li><span>03</span><strong>x402 자동 결제</strong><small>402 → paid retry → 200</small></li>
            <li><span>04</span><strong>Health 복구</strong><small>signed receipt verified</small></li>
          </ol>

          <footer className="recovery-hero__footer">
            <span><strong>Budget</strong> {demoState.mandate.incidentCapUsdc} → {demoState.mandate.remainingUsdc} USDC</span>
            <span><strong>Mandate</strong> tx ≤ {demoState.mandate.perTransactionCapUsdc} USDC · {demoState.mandate.durationMinutes === null ? "hash-bound window" : `${demoState.mandate.durationMinutes} min`}</span>
            <span><strong>Kill switch</strong> {demoState.killSwitch.engaged ? "ENGAGED" : "STANDBY"}</span>
            <a href={verifiedEvidence.explorerUrl} target="_blank" rel="noopener noreferrer">
              Solana Explorer ↗
            </a>
          </footer>
        </section>
      ) : null}

      <div
        className={`truth-banner${devnetVerified ? " is-verified" : ""}`}
        role="status"
        aria-live="polite"
      >
        <span className="truth-banner__label">EVIDENCE GATE</span>
        <strong>
          {devnetVerified
            ? "Pinned prior-run Devnet evidence verified"
            : liveUnverified
              ? "LIVE UNVERIFIED · capture revision"
              : "Devnet evidence pending"}
        </strong>
        <span>
          {devnetVerified
            ? "READ-ONLY REPLAY · 검증 adapter가 공급한 payment와 signed receipt 필드만 표시하며 새 결제를 만들지 않습니다."
            : liveUnverified
              ? "실행 응답은 수집 중인 telemetry입니다. payment-evidence와 verification report를 고정한 final revision 전에는 signature, transaction, address, Explorer를 검증된 증거로 표시하지 않습니다."
              : "현재 화면은 API adapter 연결 전 LOCAL SIMULATION입니다. 실제 signature, transaction, address, Explorer link를 표시하지 않습니다."}
        </span>
      </div>

      {!devnetVerified ? (
        <details className="operator-disclosure">
          <summary>Capture-only operator controls · Google OIDC</summary>
          <LiveOperatorTrigger
            config={liveOperatorConfig}
            onRunStarted={revealProtocolFlow}
          />
        </details>
      ) : null}

      <details
        className="protocol-disclosure"
        id="protocol-detail"
        open={protocolOpen}
        onToggle={(event) => setProtocolOpen(event.currentTarget.open)}
        ref={protocolDisclosureRef}
      >
        <summary>
          <span>
            <span className="eyebrow">PROTOCOL &amp; POLICY DETAIL</span>
            <strong>전체 x402 증거 흐름 보기</strong>
          </span>
          <span>10-step trace · 2 signed offers · 2 automatic denials</span>
        </summary>
        <div
          className={`trace-guide${runStarted && !runPaused && !runComplete ? " is-active" : ""}`}
          role="status"
          aria-live="polite"
        >
          <span>
            {runComplete
              ? "03 · 판단 완료"
              : runPaused
                ? "02 · 흐름 일시정지"
                : runStarted
                  ? "02 · 흐름 재생 중"
                  : "02 · 실행 흐름"}
          </span>
          <div>
            <strong>
              {runComplete
                ? "PASS · Gemini → A2A → 402 → 자동 서명 → settle → 200 → healthy"
                : runPaused
                  ? "일시정지됨 · 선택 단계의 상세 증거를 확인하세요."
                : runStarted
                  ? "cyan으로 강조된 현재 단계가 자동으로 이동합니다."
                  : `상단 ${devnetVerified ? "'검증된 trace 보기'" : "'로컬 incident preview'"}를 누르면 10단계가 자동 재생됩니다.`}
            </strong>
            <small>
              {runComplete
                ? "아래 PASS 요약에서 두 denial의 transactionCreated:false까지 확인하세요. 이어서 counterfactual selection flip을 비교할 수 있습니다."
                : "좌측 실행 순서와 우측 Gemini 선택 근거를 함께 확인하세요."}
            </small>
          </div>
          <div className="trace-playback-controls" aria-label="검증된 trace 재생 제어">
            <button
              type="button"
              onClick={() => stepPlayback(-1)}
              disabled={!runStarted || progressRef.current === 0}
            >
              이전
            </button>
            <button
              type="button"
              onClick={togglePlayback}
              disabled={!runStarted || runComplete}
            >
              {runPaused ? "계속" : "일시정지"}
            </button>
            <button
              type="button"
              onClick={() => stepPlayback(1)}
              disabled={runComplete}
            >
              다음
            </button>
            <button type="button" onClick={startIncident}>
              처음부터
            </button>
          </div>
        </div>
        {runComplete && devnetVerified ? (
          <section className="completion-verdict" aria-labelledby="completion-verdict-heading">
            <header>
              <span>JUDGE VERDICT</span>
              <div>
                <strong id="completion-verdict-heading">자동 결제와 안전 경계가 모두 증명되었습니다.</strong>
                <small>제출된 Devnet evidence를 다시 표시한 read-only 판정입니다.</small>
              </div>
            </header>
            <div className="completion-verdict__checks">
              <article>
                <span>PAYMENT</span>
                <strong>{paidAmountLabel} USDC FINALIZED</strong>
                <small>승인 0회 · recovery healthy</small>
              </article>
              <article>
                <span>OVER-CAP DENIED</span>
                <strong>transactionCreated:{String(overCapDenial?.transactionCreated ?? false)}</strong>
                <small>txSignature:{String(overCapDenial?.txSignature ?? null)}</small>
              </article>
              <article>
                <span>REPLAY DENIED</span>
                <strong>transactionCreated:{String(replayDenial?.transactionCreated ?? false)}</strong>
                <small>txSignature:{String(replayDenial?.txSignature ?? null)}</small>
              </article>
              <button
                type="button"
                onClick={() => setDecisionView("counterfactual")}
                aria-label="Counterfactual Gemini 선택 변경 확인"
              >
                <span>COUNTERFACTUAL</span>
                <strong>selectedOfferId CHANGED</strong>
                <small>{demoState.modelDecision.selectedOfferId} → {demoState.modelDecision.counterfactualOfferId}</small>
              </button>
            </div>
          </section>
        ) : null}
      <div className="workspace-grid">
        <section className="timeline-panel panel" id="timeline" aria-labelledby="timeline-heading">
          <header className="panel-heading timeline-heading">
            <div>
              <p className="eyebrow">AUTONOMOUS RECOVERY TRACE</p>
              <h1 id="timeline-heading">
                {devnetVerified
                  ? "Incident → paid recovery"
                  : "Incident → paid recovery preview"}
              </h1>
            </div>
            <div className="run-indicator" aria-live="polite">
              <span className={runStarted ? "pulse-dot active" : "pulse-dot"} />
              {runStarted
                ? `${completionCount} / ${demoState.timeline.length} ${devnetVerified ? "VERIFIED" : "PREVIEWED"}`
                : devnetVerified
                  ? "VERIFIED TRACE READY TO REPLAY"
                  : "WAITING FOR TEST INCIDENT"}
            </div>
          </header>

          <ol className="timeline-rail" aria-label="x402 recovery timeline">
            {demoState.timeline.map((step, index) => (
              <li key={step.id}>
                <button
                  className={`timeline-step state-${step.state}${selectedStepId === step.id ? " is-selected" : ""}`}
                  type="button"
                  onClick={() => setSelectedStepId(step.id)}
                  aria-pressed={selectedStepId === step.id}
                >
                  <span className="rail-index"><RailIcon index={index} /></span>
                  <span className="timeline-copy">
                    <span className="timeline-meta">
                      <span className="protocol-label">{step.protocolLabel}</span>
                      <span className={`step-state state-${step.state}`}>{statusLabel[step.state]}</span>
                      <time>{step.timeLabel}</time>
                    </span>
                    <strong>{step.title}</strong>
                    <small>{step.summary}</small>
                  </span>
                </button>
              </li>
            ))}
          </ol>

          <aside className="step-inspector" aria-live="polite" aria-label="선택 단계 상세">
            <span className="step-inspector__index">
              {String(demoState.timeline.findIndex((step) => step.id === selectedStepId) + 1).padStart(2, "0")}
            </span>
            <div>
              <p>{selectedStep?.protocolLabel}</p>
              <strong>{selectedStep?.title}</strong>
              <span>{selectedStep?.detail}</span>
            </div>
          </aside>
        </section>

        <aside className="decision-column" aria-label="Offer 비교 및 모델 결정">
          <section className="decision-panel panel">
            <header className="panel-heading">
              <div>
                <p className="eyebrow">A2A OFFER COMPARISON</p>
                <h2>2 immutable offers</h2>
              </div>
              <span className="count-chip">2 / 2</span>
            </header>

            <div className="offer-list">
              {demoState.offers.map((offer) => (
                <OfferCard
                  offer={{ ...offer, selected: offer.offerId === displayedOfferId }}
                  key={offer.offerId}
                />
              ))}
            </div>

            <article className="model-decision">
              <header>
                <div className="gemini-glyph" aria-hidden="true">✦</div>
                <div>
                  <p>GEMINI DECISION</p>
                  <strong>{demoState.modelDecision.modeLabel}</strong>
                </div>
              </header>
              <div className="decision-toggle" role="group" aria-label="Gemini decision evidence view">
                <button
                  type="button"
                  aria-pressed={decisionView === "baseline"}
                  onClick={() => setDecisionView("baseline")}
                >
                  BASELINE
                </button>
                <button
                  type="button"
                  aria-pressed={decisionView === "counterfactual"}
                  onClick={() => setDecisionView("counterfactual")}
                >
                  COUNTERFACTUAL
                </button>
              </div>
              <code>{displayedOfferId}</code>
              <p>
                {decisionView === "baseline"
                  ? demoState.modelDecision.rationale
                  : demoState.modelDecision.counterfactualResult}
              </p>
              <div className="counterfactual">
                <span>SELECTION FLIP</span>
                <p>
                  {demoState.modelDecision.selectedOfferId} → {demoState.modelDecision.counterfactualOfferId}
                </p>
              </div>
              <small>
                Model scope: capability + supplied offerId selection only. Money math and signing are deterministic.
              </small>
            </article>
          </section>

          <section className="denial-panel panel" aria-labelledby="denial-heading">
            <header className="panel-heading compact">
              <div>
                <p className="eyebrow red">DETERMINISTIC DENIAL</p>
                <h2 id="denial-heading">No transaction created</h2>
              </div>
              <span className="deny-shield" aria-hidden="true">×</span>
            </header>
            <div className="denial-list">
              {demoState.denials.map((denial) => (
                <article key={denial.id}>
                  <div>
                    <strong>{denial.title}</strong>
                    <code>{denial.rule}</code>
                  </div>
                  <p><span>요청</span>{denial.requestedValue}</p>
                  <p><span>정책</span>{denial.policyValue}</p>
                  <p><span>시각</span>{denial.attemptedAt}</p>
                  {denial.executionPolicyHash ? (
                    <p><span>policy hash</span><code>{denial.executionPolicyHash}</code></p>
                  ) : null}
                  {denial.replayProof ? (
                    <details className="denial-proof">
                      <summary>Replay binding · original transaction</summary>
                      <code>
                        {denial.replayProof.identifierType}:{" "}
                        {denial.replayProof.identifierValue}
                      </code>
                      <code>
                        original {denial.replayProof.originalPaymentId} → denied{" "}
                        {denial.replayProof.deniedPaymentId}
                      </code>
                      <a
                        href={denial.replayProof.originalExplorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        original Devnet transaction ↗
                      </a>
                    </details>
                  ) : null}
                  <footer>
                    <span>{denial.evidenceLevel === "devnet-verified" ? "DEVNET AUDIT" : "LOCAL HARNESS"}</span>
                    <code>
                      transactionCreated: {String(denial.transactionCreated)} · txSignature:{" "}
                      {String(denial.txSignature)}
                    </code>
                  </footer>
                  {denial.artifactHash ? <code className="denial-artifact">artifact {denial.artifactHash}</code> : null}
                </article>
              ))}
            </div>
          </section>
        </aside>
      </div>
      </details>

      <section className={`evidence-drawer panel${evidenceOpen ? " is-open" : ""}`} aria-labelledby="evidence-heading">
        <button
          className="evidence-toggle"
          type="button"
          onClick={() => setEvidenceOpen((open) => !open)}
          aria-expanded={evidenceOpen}
          aria-controls="evidence-body"
        >
          <span>
            <span className="eyebrow">PAYMENT &amp; FULFILLMENT EVIDENCE</span>
            <strong id="evidence-heading">증거 패널</strong>
          </span>
          <span className="evidence-toggle__status">
            <span className="pending-dot" /> {devnetVerified ? "DEVNET VERIFIED" : "DEVNET EVIDENCE PENDING"}
          </span>
          <span className="chevron" aria-hidden="true">{evidenceOpen ? "↓" : "↑"}</span>
        </button>

        <div className="evidence-body" id="evidence-body" hidden={!evidenceOpen}>
          {demoState.paymentEvidence.level === "devnet-verified" ? (
            <VerifiedEvidence evidence={demoState.paymentEvidence} />
          ) : (
            <div className="evidence-empty">
              <div className="evidence-empty__mark" aria-hidden="true">⌁</div>
              <div>
                <strong>실제 Devnet evidence가 아직 공급되지 않았습니다.</strong>
                <p>
                  API adapter가 independently verified evidence를 전달할 때만 public address, token delta,
                  mint, transaction signature, Explorer URL, signed receipt를 렌더링합니다.
                </p>
              </div>
              <code>evidence.level: {demoState.paymentEvidence.level}</code>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
