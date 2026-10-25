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
  return signals.banner || signals.browserClosed || signals.captionsIdleMs >= idleTimeoutMs;
}
