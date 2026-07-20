import { useEffect, useRef, useState } from "react";
import { withBase } from "./base";
import type { DashboardSnapshot, ProgressEvent } from "./types";

export type StreamStatus = "connecting" | "live" | "reconnecting";

/**
 * Subscribe to the live dashboard SSE stream. The browser auto-reconnects on
 * drop (the server sends `retry: 2000`). EventSource hides the HTTP status, so
 * on error we probe a REST endpoint to tell "server restarting" apart from
 * "session expired" — the latter fires `onUnauthorized`.
 */
export function useDashboardStream(onUnauthorized?: () => void): {
  snapshot: DashboardSnapshot | null;
  status: StreamStatus;
  progressByThread: Record<string, ProgressEvent>;
} {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [progressByThread, setProgressByThread] = useState<Record<string, ProgressEvent>>({});
  const onUnauthRef = useRef(onUnauthorized);
  onUnauthRef.current = onUnauthorized;

  useEffect(() => {
    let closed = false;
    const es = new EventSource(withBase("/events/dashboard"), { withCredentials: true });

    es.addEventListener("open", () => {
      if (!closed) setStatus("live");
    });
    es.addEventListener("snapshot", (ev) => {
      try {
        const next = JSON.parse((ev as MessageEvent).data) as DashboardSnapshot;
        setSnapshot(next);
        setProgressByThread(Object.fromEntries(
          next.activeSessionList.flatMap((session) => session.currentProgress ? [[session.threadKey, session.currentProgress]] as const : []),
        ));
        setStatus("live");
      } catch {
        // ignore malformed frame
      }
    });
    es.addEventListener("progress", (ev) => {
      try {
        const event = JSON.parse((ev as MessageEvent).data) as ProgressEvent;
        setProgressByThread((current) => {
          if (["completed", "failed", "cancelled"].includes(event.phase)) {
            const next = { ...current };
            delete next[event.threadKey];
            return next;
          }
          return { ...current, [event.threadKey]: event };
        });
      } catch {
        // ignore malformed frame
      }
    });
    es.onerror = () => {
      if (closed) return;
      setStatus("reconnecting");
      void fetch(withBase("/api/audit"), { credentials: "include" })
        .then((res) => {
          if (res.status === 401) onUnauthRef.current?.();
        })
        .catch(() => {
          /* network down — keep showing reconnecting */
        });
    };

    return () => {
      closed = true;
      es.close();
    };
  }, []);

  return { snapshot, status, progressByThread };
}
