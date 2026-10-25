import { snapshotShowsLeave, type PageSnapshot } from "../auth/joiner.js";

export interface LeaveSignals {
  banner: boolean;
  captionsIdleMs: number;
  browserClosed: boolean;
}

/** DOM half of leave detection. Idle timeout and signals land in Task 09. */
export function pageShowsLeave(snapshot: PageSnapshot): boolean {
  return snapshotShowsLeave(snapshot);
}

export function isLeaveDetected(signals: LeaveSignals, idleTimeoutMs: number): boolean {
  return leaveReason(signals, idleTimeoutMs) !== null;
}

export function leaveReason(
  signals: LeaveSignals,
  idleTimeoutMs: number,
): "banner" | "browser" | "idle" | null {
  if (signals.banner) return "banner";
  if (signals.browserClosed) return "browser";
  if (signals.captionsIdleMs >= idleTimeoutMs) return "idle";
  return null;
}

/** Poll caption idle, the leave banner, and a dead browser. Default period is 5s. */
export function startLeaveWatch(opts: {
  idleTimeoutMs: number;
  pollMs?: number;
  readSignals: () => LeaveSignals | Promise<LeaveSignals>;
  onLeave: (reason: "banner" | "browser" | "idle") => void;
}): { stop: () => void } {
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    void Promise.resolve()
      .then(() => opts.readSignals())
      .then((signals) => {
        running = false;
        if (stopped) return;
        const reason = leaveReason(signals, opts.idleTimeoutMs);
        if (!reason) return;
        stopped = true;
        clearInterval(timer);
        opts.onLeave(reason);
      })
      .catch(() => {
        running = false;
      });
  }, opts.pollMs ?? 5_000);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
