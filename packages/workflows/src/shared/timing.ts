interface StageTimerSnapshot {
  readonly startedAt?: number;
  readonly durationMs?: number;
  readonly pausedDurationMs?: number;
  readonly pausedAt?: number;
}

interface RunTimerSnapshot {
  readonly startedAt: number;
  readonly durationMs?: number;
  readonly pausedDurationMs?: number;
  readonly pausedAt?: number;
}

function nonNegative(ms: number): number {
  return Math.max(0, ms);
}

function elapsedFromStart(
  startedAt: number,
  now: number,
  pausedDurationMs: number | undefined,
  pausedAt: number | undefined,
): number {
  const completedPausedSegment = pausedDurationMs ?? 0;
  const activePausedSegment = pausedAt === undefined ? 0 : nonNegative(now - pausedAt);
  return nonNegative(now - startedAt - completedPausedSegment - activePausedSegment);
}

export function accumulatePausedDurationMs(
  pausedDurationMs: number | undefined,
  pausedAt: number | undefined,
  resumedAt: number,
): number {
  if (pausedAt === undefined) return pausedDurationMs ?? 0;
  return (pausedDurationMs ?? 0) + nonNegative(resumedAt - pausedAt);
}

export function elapsedStageMs(stage: StageTimerSnapshot, now = Date.now()): number | undefined {
  if (stage.durationMs !== undefined) return nonNegative(stage.durationMs);
  if (stage.startedAt === undefined) return undefined;
  return elapsedFromStart(stage.startedAt, now, stage.pausedDurationMs, stage.pausedAt);
}

export function elapsedRunMs(run: RunTimerSnapshot, now = Date.now()): number {
  if (run.durationMs !== undefined) return nonNegative(run.durationMs);
  return elapsedFromStart(run.startedAt, now, run.pausedDurationMs, run.pausedAt);
}
