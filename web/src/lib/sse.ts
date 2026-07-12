import { useEffect, useRef, useState } from "react";
import { withBase } from "./base";
import type { DashboardSnapshot } from "./types";

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
} {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
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
        setSnapshot(JSON.parse((ev as MessageEvent).data) as DashboardSnapshot);
        setStatus("live");
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

  return { snapshot, status };
}
