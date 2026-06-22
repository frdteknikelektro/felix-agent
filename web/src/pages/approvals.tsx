import { useMemo, useState } from "react";
import { RefreshCw, Search, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/spinner";
import { EmptyState } from "@/components/empty-state";
import { ApprovalCard } from "@/components/approval-card";
import { getList } from "@/lib/api";
import { useApiData } from "@/lib/use-api";
import type { ApprovalRecord } from "@/lib/types";

type Filter = "pending" | "all" | "approved" | "rejected";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];

export function Approvals() {
  const { data, error, loading, reload } = useApiData(() => getList<ApprovalRecord>("/api/approvals"));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("pending");

  const items = useMemo(() => {
    return (data ?? [])
      .filter((a) => (filter === "all" ? true : a.status === filter))
      .filter((a) => {
        if (!query) return true;
        const q = query.toLowerCase();
        const who = a.requester.display ?? a.requester.id;
        return a.skillId.toLowerCase().includes(q) || who.toLowerCase().includes(q) || a.source.toLowerCase().includes(q);
      })
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }, [data, query, filter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search approvals…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <Button key={f.key} size="sm" variant={filter === f.key ? "default" : "secondary"} onClick={() => setFilter(f.key)}>
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
      ) : items.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState icon={ShieldCheck} title="Nothing here" description="No approvals match this filter." />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((a) => (
            <ApprovalCard key={a.id} approval={a} onDecided={reload} />
          ))}
        </div>
      )}
    </div>
  );
}
