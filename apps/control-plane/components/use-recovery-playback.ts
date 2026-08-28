"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyTimelineProgress,
  type MissionControlDemoState,
  type MissionTimelineStep,
} from "./demo-state";

const STEP_INTERVAL_MS = 1_000;
const TERMINAL_STATES = new Set<MissionTimelineStep["state"]>([
  "local-simulated",
  "devnet-verified",
  "denied",
]);

export type RecoveryPhaseState = "waiting" | "active" | "complete";

function phaseForStep(stepId: MissionTimelineStep["id"]): number {
  if (stepId === "incident") return 1;
  if (stepId === "gemini" || stepId === "a2a") return 2;
  if (["challenge", "policy", "retry", "settle"].includes(stepId)) return 3;
  return 4;
}

export function useRecoveryPlayback(initialState: MissionControlDemoState) {
  const [demoState, setDemoState] = useState(initialState);
  const [runStarted, setRunStarted] = useState(false);
  const [runPaused, setRunPaused] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<MissionTimelineStep["id"]>(
    initialState.timeline[0]?.id ?? "incident",
  );
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressRef = useRef(0);
  const sourceStateRef = useRef(initialState);

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

  useEffect(() => {
    if (sourceStateRef.current === initialState) return;
    sourceStateRef.current = initialState;
    clearPlaybackTimer();
    progressRef.current = 0;
    setDemoState(initialState);
    setRunStarted(false);
    setRunPaused(false);
    setSelectedStepId(initialState.timeline[0]?.id ?? "incident");
  }, [clearPlaybackTimer, initialState]);

  const completionCount = demoState.timeline.filter((step) =>
    TERMINAL_STATES.has(step.state),
  ).length;
  const runComplete = runStarted && completionCount === demoState.timeline.length;
  const currentPhase = runStarted ? phaseForStep(selectedStepId) : 0;
  const selectedStep = demoState.timeline.find((step) => step.id === selectedStepId);
  const replayProgressPercent = !runStarted
    ? 0
    : runComplete
      ? 100
      : Math.round((completionCount / Math.max(demoState.timeline.length, 1)) * 100);

  const phaseState = useCallback((phase: number): RecoveryPhaseState => {
    if (!runStarted) return "waiting";
    if (runComplete || currentPhase > phase) return "complete";
    return currentPhase === phase ? "active" : "waiting";
  }, [currentPhase, runComplete, runStarted]);

  const phaseClass = useCallback((phase: number): string => {
    const state = phaseState(phase);
    if (state === "complete") return " is-complete";
    return state === "active" ? " is-active" : "";
  }, [phaseState]);

  const startPlayback = useCallback(() => {
    clearPlaybackTimer();
    setRunStarted(true);
    setTimelineProgress(0);
    beginPlayback();
  }, [beginPlayback, clearPlaybackTimer, setTimelineProgress]);

  const togglePlayback = useCallback(() => {
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
  }, [beginPlayback, clearPlaybackTimer, runComplete, runPaused, runStarted, startPlayback]);

  const playbackLabel = runComplete
    ? "처음부터 다시 보기"
    : runPaused
      ? "재생 계속"
      : runStarted
        ? "재생 일시정지"
        : "실행 과정 재생";

  return {
    completionCount,
    currentPhase,
    demoState,
    phaseClass,
    phaseState,
    playbackLabel,
    replayProgressPercent,
    runComplete,
    runPaused,
    runStarted,
    selectedStep,
    selectedStepId,
    togglePlayback,
  } as const;
}
