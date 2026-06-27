import { useState } from "react";
import { Coins, Cpu, Hash, MessagesSquare, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/spinner";
import { EmptyState } from "@/components/empty-state";
import { StatTile } from "@/components/stat-tile";
import { api } from "@/lib/api";
import { useApiData } from "@/lib/use-api";
import { compactNumber, formatNumber, sourceLabel, threadLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { UsageBreakdownRow, UsageView, UsageWindow } from "@/lib/types";

const WINDOWS: { key: UsageWindow; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "all", label: "All time" },
];

export function Usage() {
  const [window, setWindow] = useState<UsageWindow>("today");
  const { data, error, loading } = useApiData(
    () => api.get<UsageView>(`/api/usage?window=${window}`),
    [window],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-border p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => setWindow(w.key)}
              className={cn(
                "rounded px-3 py-1.5 text-sm font-medium transition-colors",
                window === w.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
        {data && <span className="text-xs text-muted-foreground">timezone: {data.tz}</span>}
      </div>

      {loading && !data ? (
        <LoadingState label="Loading usage…" />
      ) : error ? (
        <Card>
          <CardContent className="py-6 text-sm text-danger">{error}</CardContent>
        </Card>
      ) : !data || data.totals.turns === 0 ? (
        <Card>
          <CardContent>
            <EmptyState icon={Coins} title="No usage yet" description="Token usage is recorded as Felix runs turns." />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Total tokens" value={formatNumber(data.totals.total)} icon={Coins} accent="primary" />
            <StatTile label="Input" value={formatNumber(data.totals.input)} icon={Coins} accent="primary" />
            <StatTile label="Output" value={formatNumber(data.totals.output)} icon={Coins} accent="success" />
            <StatTile label="Turns" value={formatNumber(data.totals.turns)} icon={MessagesSquare} accent="primary" />
          </div>
          {(data.totals.cache_read > 0 || data.totals.cache_write > 0) && (
            <p className="text-xs text-muted-foreground">
              Cache: {formatNumber(data.totals.cache_read)} read · {formatNumber(data.totals.cache_write)} write
            </p>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <BreakdownCard title="By contact" icon={Users} rows={data.byContact} rowLimit={data.breakdownLimit} labelOf={(k) => k} />
            <BreakdownCard title="By source" icon={MessagesSquare} rows={data.bySource} rowLimit={data.breakdownLimit} labelOf={sourceLabel} />
            <BreakdownCard title="By model" icon={Cpu} rows={data.byModel} rowLimit={data.breakdownLimit} labelOf={(k) => k} />
            <BreakdownCard title="By thread" icon={Hash} rows={data.byThread} rowLimit={data.breakdownLimit} labelOf={threadLabel} />
          </div>
        </>
      )}
    </div>
  );
}

function BreakdownCard({
  title,
  icon: Icon,
  rows,
  rowLimit,
  labelOf,
}: {
  title: string;
  icon: typeof Users;
  rows: UsageBreakdownRow[];
  rowLimit: number;
  labelOf: (key: string) => string;
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.total), 0) || 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState icon={Icon} title="No data" />
        ) : (
          <ul className="space-y-2.5">
            {rows.slice(0, rowLimit).map((r) => (
              <li key={r.key}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate" title={r.key}>
                    {labelOf(r.key)}
                  </span>
                  <span className="shrink-0 tabular-nums" title={`${formatNumber(r.total)} tokens · ${r.turns} turns`}>
                    {compactNumber(r.total)}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.max(2, (r.total / max) * 100)}%` }}
                  />
                </div>
              </li>
            ))}
            {rows.length > rowLimit && (
              <li className="pt-1 text-xs text-muted-foreground">+{rows.length - rowLimit} more</li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
