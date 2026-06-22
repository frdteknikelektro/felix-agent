import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CircleDot, MessageSquare, RefreshCw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/spinner";
import { EmptyState } from "@/components/empty-state";
import { SourceBadge } from "@/components/source-badge";
import { getList } from "@/lib/api";
import { useApiData } from "@/lib/use-api";
import { sourceLabel, threadLabel, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SessionSummary } from "@/lib/types";

type Filter = "all" | "busy" | "queued" | "approval";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "busy", label: "Busy" },
  { key: "queued", label: "Queued" },
  { key: "approval", label: "Needs approval" },
];

export function Sessions() {
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApiData(() => getList<SessionSummary>("/api/sessions"));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const groups = useMemo(() => {
    const sessions = (data ?? []).filter((s) => {
      if (filter === "busy" && !s.busy) return false;
      if (filter === "queued" && s.queueLength === 0) return false;
      if (filter === "approval" && !s.pendingPermissionId) return false;
      if (query) {
        const q = query.toLowerCase();
        if (!s.threadKey.toLowerCase().includes(q) && !s.source.toLowerCase().includes(q)) return false;
      }
      return true;
    });
    const map = new Map<string, SessionSummary[]>();
    for (const s of sessions) {
      const list = map.get(s.source) ?? [];
      list.push(s);
      map.set(s.source, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data, query, filter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search threads…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <Button
              key={f.key}
              size="sm"
              variant={filter === f.key ? "default" : "secondary"}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </Button>
          ))}
        </div>
        <Button size="icon" variant="ghost" aria-label="Refresh" onClick={reload}>
          <RefreshCw />
        </Button>
      </div>

      {loading && !data ? (
        <LoadingState />
      ) : error ? (
        <Card>
          <CardContent className="py-6 text-sm text-danger">{error}</CardContent>
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState icon={MessageSquare} title="No sessions match" description="Try clearing the search or filter." />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          {groups.map(([source, sessions]) => (
            <section key={source}>
              <div className="mb-2 flex items-center gap-2">
                <SourceBadge source={source} />
                <span className="text-xs text-muted-foreground">
                  {sessions.length} {sessions.length === 1 ? "thread" : "threads"}
                </span>
              </div>
              <Card>
                <CardContent className="divide-y divide-border p-0">
                  {sessions.map((s) => (
                    <button
                      key={s.threadKey}
                      onClick={() => navigate(`/sessions/${encodeURIComponent(s.threadKey)}`)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                    >
                      <CircleDot
                        className={cn("size-4 shrink-0", s.busy ? "text-success" : "text-muted-foreground/40")}
                        style={s.busy ? { animation: "felix-pulse 1.5s ease-in-out infinite" } : undefined}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{threadLabel(s.threadKey)}</p>
                        <p className="truncate text-xs text-muted-foreground">{sourceLabel(s.source)}</p>
                      </div>
                      {s.queueLength > 0 && <Badge variant="primary">{s.queueLength} queued</Badge>}
                      {s.pendingPermissionId && <Badge variant="warning">needs approval</Badge>}
                      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
                        {timeAgo(s.lastEventAt ?? s.updatedAt)}
                      </span>
                    </button>
                  ))}
                </CardContent>
              </Card>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
