export type StopReason = "clean" | "interrupt" | "crash";

export function exitCodeFor(reason: StopReason): number {
  switch (reason) {
    case "clean":
      return 0;
    case "interrupt":
      return 130;
    case "crash":
      return 1;
    default: {
      const unexpected: never = reason;
      return unexpected;
    }
  }
}

export function installMeetingSignals(hooks: {
  onInterrupt: () => void;
  onCrash: (err: unknown) => void;
}): () => void {
  const onInterrupt = (): void => hooks.onInterrupt();
  const onCrash = (err: unknown): void => hooks.onCrash(err);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  process.on("uncaughtException", onCrash);
  return () => {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
    process.off("uncaughtException", onCrash);
  };
}
