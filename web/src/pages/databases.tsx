import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Database, Plus, RefreshCw, Search, Server, HardDrive, Cloud } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/empty-state";
import { LoadingState } from "@/components/ui/spinner";
import { useApiData } from "@/lib/use-api";
import { getList } from "@/lib/api";
import type { DatabaseConnectionSummary } from "@/lib/types";
import { fullTime } from "@/lib/format";

const ENGINE_ICONS: Record<string, typeof Database> = {
  postgresql: Server,
  mysql: Server,
  sqlite: HardDrive,
  mongodb: Database,
  redis: Database,
  dynamodb: Cloud,
  cosmos: Cloud,
};

const ENGINE_COLORS: Record<string, string> = {
  postgresql: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  mysql: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
  sqlite: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300",
  mongodb: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  redis: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
  dynamodb: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
  cosmos: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300",
};

export function Databases() {
  const { data: connections, error, loading, reload } = useApiData<DatabaseConnectionSummary[]>(
    () => getList<DatabaseConnectionSummary>("/api/databases"),
    [],
  );
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!connections) return [];
    if (!query.trim()) return connections;
    const q = query.toLowerCase();
    return connections.filter(
      (c) =>
        c.alias.toLowerCase().includes(q) ||
        c.engine.toLowerCase().includes(q) ||
        (c.host ?? "").toLowerCase().includes(q) ||
        (c.database ?? "").toLowerCase().includes(q) ||
        c.notes.toLowerCase().includes(q),
    );
  }, [connections, query]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search connections..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
          <RefreshCw className="size-4" />
        </Button>
        <Link to="/databases/new">
          <Button size="sm">
            <Plus className="mr-1.5 size-4" />
            Add Connection
          </Button>
        </Link>
      </div>

      {loading && !connections ? (
        <LoadingState label="Loading connections..." />
      ) : error ? (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={Database}
              title={connections && connections.length > 0 ? "No matches" : "No database connections"}
              description={
                connections && connections.length > 0
                  ? "Try a different search term."
                  : "Add a database connection to get started."
              }
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="divide-y divide-border p-0">
            {filtered.map((conn) => {
              const Icon = ENGINE_ICONS[conn.engine] ?? Database;
              const colorClass = ENGINE_COLORS[conn.engine] ?? "bg-secondary text-secondary-foreground";
              return (
                <Link
                  key={conn.alias}
                  to={`/databases/${conn.alias}`}
                  className="flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                >
                  <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                    <Icon className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{conn.alias}</span>
                      <Badge variant="outline" className={colorClass}>
                        {conn.engine}
                      </Badge>
                      {conn.last_tested_ok === true && (
                        <Badge variant="success" className="text-xs">OK</Badge>
                      )}
                      {conn.last_tested_ok === false && (
                        <Badge variant="danger" className="text-xs">Failed</Badge>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {conn.host && <span>{conn.host}</span>}
                      {conn.database && <span> / {conn.database}</span>}
                      {!conn.host && !conn.database && <span>{conn.notes || "No details"}</span>}
                    </div>
                    {conn.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {conn.tags.map((tag) => (
                          <Badge key={tag} variant="default" className="text-xs">{tag}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {conn.last_tested ? fullTime(conn.last_tested) : "Never tested"}
                  </div>
                </Link>
              );
            })}
          </CardContent>
        </Card>
      )}

      {connections && connections.length > 0 && (
        <div className="text-right text-xs text-muted-foreground">
          {connections.length} connection{connections.length !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}
