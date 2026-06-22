import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Search, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/spinner";
import { EmptyState } from "@/components/empty-state";
import { SourceBadge } from "@/components/source-badge";
import { getList } from "@/lib/api";
import { useApiData } from "@/lib/use-api";
import type { ContactRecord } from "@/lib/types";

export function Contacts() {
  const navigate = useNavigate();
  const { data, error, loading } = useApiData(() => getList<ContactRecord>("/api/contacts"));
  const [query, setQuery] = useState("");

  const items = useMemo(() => {
    const q = query.toLowerCase();
    return (data ?? []).filter(
      (c) =>
        !q ||
        c.user_id.toLowerCase().includes(q) ||
        (c.display ?? "").toLowerCase().includes(q) ||
        (c.username ?? "").toLowerCase().includes(q),
    );
  }, [data, query]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search contacts…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Button onClick={() => navigate("/contacts/new")}>
          <Plus /> New contact
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
            <EmptyState icon={Users} title="No contacts" description="Add one to grant a user standing permissions." />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="divide-y divide-border p-0">
            {items.map((c) => (
              <button
                key={`${c.source}:${c.user_id}`}
                onClick={() => navigate(`/contacts/${c.source}/${c.user_id}`)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{c.display || c.user_id}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.username ? `@${c.username.replace(/^@/, "")} · ` : ""}
                    {c.user_id}
                  </p>
                </div>
                <SourceBadge source={c.source} />
                <Badge variant="outline">
                  {c.allowed_permissions.length} {c.allowed_permissions.length === 1 ? "perm" : "perms"}
                </Badge>
              </button>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
