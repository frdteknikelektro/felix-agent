import type http from "node:http";
import type { AppConfig } from "../config.js";
import { log } from "../lib/log.js";
import { dashboardSnapshot, type DashboardSnapshot } from "../owner-data.js";

/**
 * Server-Sent Events feed for the live dashboard. One shared poller computes a
 * {@link DashboardSnapshot} every {@link POLL_INTERVAL_MS} and broadcasts it to
 * every connected client — N clients never trigger N independent disk scans.
 * The interval runs only while at least one client is connected.
 */

const POLL_INTERVAL_MS = 1000;

const clients = new Set<http.ServerResponse>();
let timer: NodeJS.Timeout | null = null;
let ticking = false;
let cfgRef: AppConfig | null = null;
let lastSnapshot: DashboardSnapshot | null = null;

export function addDashboardClient(
  cfg: AppConfig,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  cfgRef = cfg;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Disable proxy buffering so events flush immediately.
    "X-Accel-Buffering": "no",
  });
  // Tell EventSource to wait 2s before reconnecting after a drop.
  res.write("retry: 2000\n\n");
  clients.add(res);
  if (lastSnapshot) writeSnapshot(res, lastSnapshot);

  startPolling();

  const cleanup = (): void => {
    if (!clients.delete(res)) return;
    if (clients.size === 0) stopPolling();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

/** Detach every client and stop the poller — used on graceful shutdown. */
export function closeDashboardClients(): void {
  for (const res of clients) {
    try {
      res.end();
    } catch {
      // ignore — connection already gone
    }
  }
  clients.clear();
  stopPolling();
}

function startPolling(): void {
  if (timer) return;
  void tick();
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  // Don't keep the event loop alive solely for the dashboard poll.
  timer.unref?.();
}

function stopPolling(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  lastSnapshot = null;
}

async function tick(): Promise<void> {
  if (ticking || !cfgRef || clients.size === 0) return;
  ticking = true;
  try {
    const snapshot = await dashboardSnapshot(cfgRef);
    lastSnapshot = snapshot;
    for (const res of clients) writeSnapshot(res, snapshot);
  } catch (error: any) {
    log.error("sse.dashboard_tick_error", { error: error?.message || String(error) });
  } finally {
    ticking = false;
  }
}

function writeSnapshot(res: http.ServerResponse, snapshot: DashboardSnapshot): void {
  try {
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  } catch {
    // ignore — connection cleanup will remove it
  }
}
