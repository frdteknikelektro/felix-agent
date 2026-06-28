// ─── Turn cancellation ────────────────────────────────────────────────────────
//
// The single owner of per-thread turn cancellation. Two pieces of state used to
// live as raw fields on the engine, with the request/check/clear cycle spread
// across engine.ts, turn-runner.ts, and turn-outcome.ts. This Module concentrates
// them so "how does stopping a turn work" has one home:
//
//   - a request flag set    (a stop was asked for, not yet consumed)
//   - an AbortController map (the in-flight turn's abort signal)
//
// The engine holds one of these and exposes isRequested/clear to the turn runner
// and outcome handler through their existing ports — those modules stay unaware
// of the controller wiring.

export interface TurnCancellation {
  /** Request cancellation for a thread: flag it and abort its in-flight signal. */
  request(threadKey: string): void;
  /** True when a request is outstanding (set and not yet cleared). */
  isRequested(threadKey: string): boolean;
  /** Consume the request flag. Leaves the active controller alone. */
  clear(threadKey: string): void;
  /** Begin a cancellable turn run: install a fresh controller, return its signal. */
  begin(threadKey: string): AbortSignal;
  /** End a turn run: drop the controller and clear any lingering request flag. */
  end(threadKey: string): void;
}

export function createTurnCancellation(): TurnCancellation {
  const requested = new Set<string>();
  const controllers = new Map<string, AbortController>();

  return {
    request(threadKey: string): void {
      requested.add(threadKey);
      controllers.get(threadKey)?.abort();
    },
    isRequested(threadKey: string): boolean {
      return requested.has(threadKey);
    },
    clear(threadKey: string): void {
      requested.delete(threadKey);
    },
    begin(threadKey: string): AbortSignal {
      const controller = new AbortController();
      controllers.set(threadKey, controller);
      return controller.signal;
    },
    end(threadKey: string): void {
      controllers.delete(threadKey);
      requested.delete(threadKey);
    },
  };
}
