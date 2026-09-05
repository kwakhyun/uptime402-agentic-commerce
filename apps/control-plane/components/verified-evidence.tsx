"use client";

import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { Check } from "@phosphor-icons/react/Check";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";

import type { VerifiedPaymentEvidenceView } from "./demo-state";

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

export function VerifiedEvidence({ evidence }: { evidence: VerifiedPaymentEvidenceView }) {
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
          <strong>Devnet 결제와 라우트 활성화 검증 완료</strong>
          <span>
            receiptVerified: {String(evidence.receiptVerified)} · outcomeVerified: {String(evidence.outcomeVerified)}
          </span>
        </div>
      </div>

      <details className="evidence-subsection">
        <summary>온체인 결제와 계정 잔액 변화 <CaretDown size={16} aria-hidden="true" /></summary>
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
        <summary>예산 예약부터 사용 확정까지 <CaretDown size={16} aria-hidden="true" /></summary>
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
        <summary>서명 영수증과 실행 결과의 연결 <CaretDown size={16} aria-hidden="true" /></summary>
        <EvidenceRows rows={receiptRows} />
      </details>
    </div>
  );
}
