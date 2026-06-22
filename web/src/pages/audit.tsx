import { useMemo, useState } from "react";
import { RefreshCw, ScrollText, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/spinner";
import { EmptyState } from "@/components/empty-state";
import { getList } from "@/lib/api";
import { useApiData } from "@/lib/use-api";
import { fullTime, timeAgo } from "@/lib/format";
import type { AuditEntry } from "@/lib/types";

const ACTION_VARIANT: Record<string, "success" | "danger" | "primary" | "default"> = {
  create: "success",
  approve: "success",
  update: "primary",
  reject: "danger",
  delete: "danger",
};

export function Audit() {
  const { data, error, loading, reload } = useApiData(() => getList<AuditEntry>("/api/audit"));
  const [query, setQuery] = useState("");

  const items = useMemo(() => {
    const q = query.toLowerCase();
    return (data ?? [])
      .filter(
        (a) =>
          !q ||
          a.summary.toLowerCase().includes(q) ||
          a.entity_type.toLowerCase().includes(q) ||
          a.action.toLowerCase().includes(q),
      )
      .sort((a, b) => b.at.localeCompare(a.at));
  }, [data, query]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search audit log…" value={query} onChange={(e) => setQuery(e.target.value)} />
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
      ) : items.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState icon={ScrollText} title="No audit entries" description="Owner actions are recorded here." />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="divide-y divide-border p-0">
            {items.map((a) => (
              <div key={a.id} className="flex items-start gap-3 px-4 py-3">
                <Badge variant={ACTION_VARIANT[a.action] ?? "default"}>{a.action}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{a.summary}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.entity_type} · {a.source}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground" title={fullTime(a.at)}>
                  {timeAgo(a.at)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
