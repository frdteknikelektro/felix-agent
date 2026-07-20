import { useNavigate } from "react-router-dom";
import {
  Activity,
  CircleDot,
  Clock,
  Coins,
  ListChecks,
  MessageSquare,
  Radio,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/spinner";
import { StatTile } from "@/components/stat-tile";
import { SourceBadge } from "@/components/source-badge";
import { ApprovalCard } from "@/components/approval-card";
import { EmptyState } from "@/components/empty-state";
import { useDashboardStream, type StreamStatus } from "@/lib/sse";
import { compactNumber, formatElapsed, threadLabel, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashboardActiveSession, DashboardActivityItem } from "@/lib/types";

export function Dashboard() {
  const navigate = useNavigate();
  const { snapshot, status } = useDashboardStream(() => navigate("/login", { replace: true }));

  if (!snapshot) {
    return (
      <div className="space-y-4">
        <ConnectionPill status={status} />
        <LoadingState label="Connecting to live stream…" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ConnectionPill status={status} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Active sessions" value={snapshot.activeSessions} icon={Radio} accent="primary" />
        <StatTile label="Queued events" value={snapshot.totalQueueDepth} icon={Clock} accent="primary" />
        <StatTile
          label="Pending approvals"
          value={snapshot.pendingApprovals}
          icon={ShieldAlert}
          accent={snapshot.pendingApprovals > 0 ? "warning" : "primary"}
        />
        <StatTile label="Sessions today" value={snapshot.sessionsToday} icon={MessageSquare} accent="success" />
        <StatTile label="Tokens today" value={compactNumber(snapshot.tokensToday)} icon={Coins} accent="success" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {snapshot.pendingApprovalList.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldAlert className="size-4 text-warning" />
                  Pending approvals
                  <Badge variant="warning">{snapshot.pendingApprovalList.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {snapshot.pendingApprovalList.map((a) => (
                  <ApprovalCard key={a.id} approval={a} />
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ListChecks className="size-4" />
                Active sessions
              </CardTitle>
            </CardHeader>
            <CardContent>
              {snapshot.activeSessionList.length === 0 ? (
                <EmptyState icon={MessageSquare} title="No sessions yet" description="Threads appear here as messages arrive." />
              ) : (
                <div className="divide-y divide-border">
                  {snapshot.activeSessionList.map((s) => (
                    <SessionRow key={s.threadKey} session={s} onOpen={() => navigate(`/sessions/${encodeURIComponent(s.threadKey)}`)} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-4" />
              Live activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {snapshot.recentActivity.length === 0 ? (
              <EmptyState icon={Activity} title="No activity yet" />
            ) : (
              <ol className="space-y-3">
                {snapshot.recentActivity.map((item, i) => (
                  <ActivityRow key={`${item.at}-${i}`} item={item} />
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ConnectionPill({ status }: { status: StreamStatus }) {
  const map = {
    live: { label: "Live", className: "text-success", dot: "bg-success" },
    connecting: { label: "Connecting…", className: "text-muted-foreground", dot: "bg-muted-foreground" },
    reconnecting: { label: "Reconnecting…", className: "text-warning", dot: "bg-warning" },
  } as const;
  const s = map[status];
  return (
    <div className="flex items-center gap-2 text-xs font-medium">
      <span
        className={cn("size-2 rounded-full", s.dot)}
        style={status !== "live" ? { animation: "felix-pulse 1.2s ease-in-out infinite" } : undefined}
      />
      <span className={s.className}>{s.label}</span>
    </div>
  );
}

function SessionRow({ session, onOpen }: { session: DashboardActiveSession; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="flex w-full items-center gap-3 py-2.5 text-left transition-colors hover:bg-muted/50">
      <CircleDot
        className={cn("size-4 shrink-0", session.busy ? "text-success" : "text-muted-foreground/40")}
        style={session.busy ? { animation: "felix-pulse 1.5s ease-in-out infinite" } : undefined}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{threadLabel(session.threadKey)}</span>
      <SourceBadge source={session.source} />
      <Badge variant="outline">{session.harness}</Badge>
      {session.currentProgress && (
        <Badge variant="primary">
          {session.currentProgress.status} · {formatElapsed(session.currentProgress.elapsedMs)}
        </Badge>
      )}
      {session.queueLength > 0 && <Badge variant="primary">{session.queueLength} queued</Badge>}
      {session.pendingPermissionSkillId && <Badge variant="warning">needs approval</Badge>}
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
        {timeAgo(session.lastEventAt ?? session.updatedAt)}
      </span>
    </button>
  );
}

const ACTIVITY_ICON = {
  audit: Sparkles,
  turn: MessageSquare,
  message: MessageSquare,
} as const;

function ActivityRow({ item }: { item: DashboardActivityItem }) {
  const Icon = ACTIVITY_ICON[item.kind];
  return (
    <li className="flex items-start gap-2.5">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">{item.summary}</p>
        <p className="text-xs text-muted-foreground">{timeAgo(item.at)}</p>
      </div>
    </li>
  );
}
