"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  parseLiveOperatorUiResponse,
  type LiveOperatorUiConfig,
  type LiveOperatorUiResponse,
} from "../src/live-ui-contract";

type GoogleCredentialResponse = Readonly<{
  credential?: unknown;
  select_by?: unknown;
}>;

type GoogleIdentityApi = Readonly<{
  initialize(config: Readonly<{
    client_id: string;
    callback(response: GoogleCredentialResponse): void;
    auto_select: false;
    cancel_on_tap_outside: true;
    itp_support: true;
    ux_mode: "popup";
  }>): void;
  renderButton(
    parent: HTMLElement,
    options: Readonly<{
      type: "standard";
      theme: "outline";
      size: "medium";
      text: "continue_with";
      shape: "rectangular";
      logo_alignment: "left";
      locale: "ko";
      width: number;
    }>,
  ): void;
}>;

declare global {
  interface Window {
    google?: Readonly<{
      accounts: Readonly<{ id: GoogleIdentityApi }>;
    }>;
  }
}

type LiveRunState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "running" }>
  | Readonly<{ status: "succeeded"; response: LiveOperatorUiResponse }>
  | Readonly<{ status: "failed"; errorCode: string }>;

const MAX_LIVE_RESPONSE_BYTES = 128 * 1024;

function safeErrorCode(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).error === "string"
  ) {
    const code = (value as Record<string, unknown>).error as string;
    return /^[a-z0-9_.-]{1,128}$/u.test(code) ? code : null;
  }
  return null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("operator_response_not_json");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_LIVE_RESPONSE_BYTES) {
    throw new Error("operator_response_size_invalid");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("operator_response_json_invalid");
  }
}

function resultLabel(response: LiveOperatorUiResponse): string {
  if (response.idempotentReplay) return "IDEMPOTENT SUMMARY · NO NEW RUN";
  if (response.primary.outcome === "recovered") return "RECOVERED · VERIFICATION PENDING";
  if (response.primary.outcome === "denied") return "DENIED · NO PAYMENT CLAIM";
  return "RECONCILIATION REQUIRED · NO RETRY";
}

export function LiveOperatorTrigger({
  config,
}: {
  config: LiveOperatorUiConfig;
}) {
  const [libraryReady, setLibraryReady] = useState(false);
  const [run, setRun] = useState<LiveRunState>({ status: "idle" });
  const googleButtonRef = useRef<HTMLDivElement | null>(null);
  const initializedRef = useRef(false);
  const busyRef = useRef(false);

  const executeServerOwnedIncident = useCallback(async (idToken: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setRun({ status: "running" });
    let credential = idToken;
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${credential}`,
    });
    credential = "";
    try {
      const response = await fetch("/api/operator/incidents/demo-run", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers,
      });
      headers.delete("authorization");
      const body = await readBoundedJson(response);
      if (!response.ok) {
        setRun({
          status: "failed",
          errorCode: safeErrorCode(body) ?? `operator_http_${response.status}`,
        });
        return;
      }
      if (response.headers.get("x-uptime402-evidence-level") !== "live-unverified") {
        throw new Error("operator_evidence_label_missing");
      }
      setRun({ status: "succeeded", response: parseLiveOperatorUiResponse(body) });
    } catch (error) {
      headers.delete("authorization");
      setRun({
        status: "failed",
        errorCode:
          error instanceof Error && /^[a-z0-9_.-]{1,128}$/u.test(error.message)
            ? error.message
            : "operator_live_request_failed",
      });
    } finally {
      busyRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (window.google?.accounts.id) setLibraryReady(true);
  }, []);

  useEffect(() => {
    if (
      config.mode !== "google-oidc-live" ||
      !libraryReady ||
      initializedRef.current ||
      !googleButtonRef.current
    ) {
      return;
    }
    if (config.clientId !== config.audience) {
      setRun({ status: "failed", errorCode: "operator_client_audience_mismatch" });
      return;
    }
    const identity = window.google?.accounts.id;
    if (!identity) return;
    initializedRef.current = true;
    googleButtonRef.current.replaceChildren();
    identity.initialize({
      client_id: config.clientId,
      callback(response) {
        if (typeof response.credential !== "string" || response.credential.length > 16_384) {
          setRun({ status: "failed", errorCode: "operator_token_invalid" });
          return;
        }
        void executeServerOwnedIncident(response.credential);
      },
      auto_select: false,
      cancel_on_tap_outside: true,
      itp_support: true,
      ux_mode: "popup",
    });
    identity.renderButton(googleButtonRef.current, {
      type: "standard",
      theme: "outline",
      size: "medium",
      text: "continue_with",
      shape: "rectangular",
      logo_alignment: "left",
      locale: "ko",
      width: 238,
    });
  }, [config, executeServerOwnedIncident, libraryReady]);

  if (config.mode === "disabled") return null;

  return (
    <section className={`live-operator-panel live-${run.status}`} aria-labelledby="live-operator-heading">
      <Script
        id="google-identity-services"
        src="https://accounts.google.com/gsi/client"
        strategy="afterInteractive"
        onReady={() => setLibraryReady(true)}
        onError={() => setRun({ status: "failed", errorCode: "google_identity_unavailable" })}
      />
      <div className="live-operator-copy">
        <p className="eyebrow">LIVE OPERATOR · GOOGLE OIDC</p>
        <h2 id="live-operator-heading">서버 고정 incident를 한 번 실행</h2>
        <span>
          Google 인증 callback이 server-owned request를 즉시 실행합니다. 브라우저는
          policy·금액·recipient·nonce를 보내지 않으며 ID token을 저장하지 않습니다.
        </span>
      </div>
      <div className="live-operator-action">
        <div ref={googleButtonRef} className="google-identity-button" aria-label="Google operator authentication" />
        <small>
          {run.status === "running"
            ? "LIVE RUNNING · payment approval prompt 없음"
            : "인증 성공 즉시 실행 · Firestore one-shot guard"}
        </small>
      </div>
      <div className="live-operator-truth" role="status" aria-live="polite">
        <strong>LIVE UNVERIFIED</strong>
        <span>
          이 응답은 실행 telemetry이며 Devnet 증거가 아닙니다. independent evidence verifier 전에는
          Explorer, token delta, confirmed payment, verified receipt를 표시하지 않습니다.
        </span>
      </div>
      {run.status === "failed" ? (
        <div className="live-operator-error">
          <strong>LIVE RUN NOT STARTED / NOT PROMOTED</strong>
          <code>{run.errorCode}</code>
        </div>
      ) : null}
      {run.status === "succeeded" ? (
        <div className="live-operator-result">
          <header>
            <strong>{resultLabel(run.response)}</strong>
            <span>
              transactionCreated: {String(run.response.primary.transactionCreated)} · events: {run.response.events.length}
            </span>
          </header>
          <code className="live-request-hash">runBindingHash {run.response.runBindingHash}</code>
          {run.response.primary.reasonCode ? <code>{run.response.primary.reasonCode}</code> : null}
          {run.response.events.length > 0 ? (
            <ol aria-label="Live unverified response events">
              {run.response.events.map((event) => (
                <li key={`${event.phase}-${event.correlationId}-${event.sequence}`}>
                  <span>{String(event.sequence).padStart(2, "0")}</span>
                  <div>
                    <strong>{event.protocolLabel}</strong>
                    <code>{event.phase} · {event.kind}</code>
                  </div>
                  <time>{event.occurredAt}</time>
                  <small>transactionCreated: {String(event.transactionCreated)}</small>
                </li>
              ))}
            </ol>
          ) : (
            <p>기존 one-shot action의 terminal summary입니다. 새 live event나 결제는 생성되지 않았습니다.</p>
          )}
          {run.response.denials ? (
            <footer>
              <strong>AUTOMATIC DUAL DENIAL</strong>
              <code>
                {run.response.denials.overTransactionLimit.reasonCode} ·{" "}
                {run.response.denials.replay.reasonCode}
              </code>
              <span>2 × transactionCreated: false</span>
            </footer>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
