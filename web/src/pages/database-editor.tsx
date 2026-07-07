import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LoadingState } from "@/components/ui/spinner";
import { useApiData } from "@/lib/use-api";
import { useUnsavedGuard } from "@/lib/use-unsaved";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import type { DatabaseConnection } from "@/lib/types";

const ENGINES = ["postgresql", "mysql", "sqlite", "mongodb", "redis", "dynamodb", "cosmos"];

interface FieldProps {
  label: string;
  children: React.ReactNode;
}

function Field({ label, children }: FieldProps) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function DatabaseEditor({ mode }: { mode: "create" | "edit" }) {
  const { alias: urlAlias } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const alias = mode === "edit" ? urlAlias ?? "" : "";

  const { data: existing, loading: loadingExisting } = useApiData<DatabaseConnection | null>(
    () => (mode === "edit" && alias ? api.get<DatabaseConnection>(`/api/databases/${alias}`) : Promise.resolve(null)),
    [mode, alias],
  );

  const [engine, setEngine] = useState("postgresql");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("5432");
  const [database, setDatabase] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshUser, setSshUser] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("10000");
  const [maxConnections, setMaxConnections] = useState("5");
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useUnsavedGuard(dirty);

  useEffect(() => {
    if (existing) {
      setEngine(existing.engine);
      setHost((existing.engine_config["host"] as string) ?? "");
      setPort(String(existing.engine_config["port"] ?? "5432"));
      setDatabase((existing.engine_config["database"] as string) ?? "");
      setUser((existing.engine_config["user"] as string) ?? "");
      setPassword(""); // never load existing password
      setSshHost((existing.ssh?.["host"] as string) ?? "");
      setSshUser((existing.ssh?.["user"] as string) ?? "");
      setSshPort(String(existing.ssh?.["port"] ?? "22"));
      setSshKeyPath((existing.ssh?.["key_path"] as string) ?? "");
      setTimeoutMs(String(existing.timeout_ms));
      setMaxConnections(String(existing.max_connections));
      setTags(existing.tags.join(", "));
      setNotes(existing.notes);
    }
  }, [existing]);

  const markDirty = () => setDirty(true);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "edit" && !alias) return;
    const newAlias = mode === "create" ? (document.getElementById("alias-input") as HTMLInputElement)?.value : alias;
    if (!newAlias?.trim()) {
      toast({ title: "Alias is required", variant: "error" });
      return;
    }

    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        alias: newAlias.trim(),
        engine,
        engine_config: {
          host: host || undefined,
          port: parseInt(port, 10) || undefined,
          database: database || undefined,
          user: user || undefined,
          password: password ? { plaintext: password } : undefined,
        },
        ssh: sshHost ? {
          host: sshHost,
          user: sshUser || "root",
          port: parseInt(sshPort, 10) || 22,
          key_path: sshKeyPath || "~/.ssh/id_ed25519",
        } : null,
        timeout_ms: parseInt(timeoutMs, 10) || 10000,
        max_connections: parseInt(maxConnections, 10) || 5,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        notes,
      };

      if (mode === "create") {
        await api.post("/api/databases", body);
        toast({ title: "Connection created", variant: "success" });
        navigate(`/databases/${newAlias.trim()}`);
      } else {
        await api.put(`/api/databases/${alias}`, body);
        toast({ title: "Connection updated", variant: "success" });
        setDirty(false);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      toast({ title: `Save failed: ${msg}`, variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!alias || !confirm("Delete this connection?")) return;
    setBusy(true);
    try {
      await api.del(`/api/databases/${alias}`);
      toast({ title: "Connection deleted", variant: "success" });
      navigate("/databases");
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      toast({ title: `Delete failed: ${msg}`, variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  if (mode === "edit" && loadingExisting) {
    return <LoadingState label="Loading connection..." />;
  }

  if (mode === "edit" && !existing) {
    return <div className="text-sm text-muted-foreground">Connection not found.</div>;
  }

  return (
    <div className="space-y-4">
      <button
        onClick={() => navigate("/databases")}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> All connections
      </button>

      <Card>
        <CardContent className="p-5">
          <form onSubmit={save} className="space-y-4">
            {mode === "create" && (
              <Field label="Alias">
                <Input id="alias-input" placeholder="e.g. prod-pg" onChange={markDirty} />
              </Field>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Engine">
                <select
                  value={engine}
                  onChange={(e) => { setEngine(e.target.value); markDirty(); }}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {ENGINES.map((e) => (
                    <option key={e} value={e}>{e}</option>
                  ))}
                </select>
              </Field>

              <Field label="Port">
                <Input value={port} onChange={(e) => { setPort(e.target.value); markDirty(); }} />
              </Field>
            </div>

            <Field label="Host">
              <Input value={host} onChange={(e) => { setHost(e.target.value); markDirty(); }} placeholder="e.g. db.example.com" />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Database">
                <Input value={database} onChange={(e) => { setDatabase(e.target.value); markDirty(); }} />
              </Field>
              <Field label="User">
                <Input value={user} onChange={(e) => { setUser(e.target.value); markDirty(); }} />
              </Field>
            </div>

            <Field label="Password">
              <Input
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); markDirty(); }}
                placeholder={mode === "edit" ? "Leave blank to keep existing" : ""}
              />
            </Field>

            <div className="border-t pt-4">
              <h3 className="mb-3 text-sm font-medium">SSH Tunnel (optional)</h3>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="SSH Host">
                  <Input value={sshHost} onChange={(e) => { setSshHost(e.target.value); markDirty(); }} />
                </Field>
                <Field label="SSH User">
                  <Input value={sshUser} onChange={(e) => { setSshUser(e.target.value); markDirty(); }} />
                </Field>
                <Field label="SSH Port">
                  <Input value={sshPort} onChange={(e) => { setSshPort(e.target.value); markDirty(); }} />
                </Field>
              </div>
              <Field label="SSH Key Path">
                <Input value={sshKeyPath} onChange={(e) => { setSshKeyPath(e.target.value); markDirty(); }} placeholder="~/.ssh/id_ed25519" />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Timeout (ms)">
                <Input value={timeoutMs} onChange={(e) => { setTimeoutMs(e.target.value); markDirty(); }} />
              </Field>
              <Field label="Max Connections">
                <Input value={maxConnections} onChange={(e) => { setMaxConnections(e.target.value); markDirty(); }} />
              </Field>
            </div>

            <Field label="Tags (comma-separated)">
              <Input value={tags} onChange={(e) => { setTags(e.target.value); markDirty(); }} placeholder="e.g. production, primary" />
            </Field>

            <Field label="Notes">
              <Textarea value={notes} onChange={(e) => { setNotes(e.target.value); markDirty(); }} rows={3} />
            </Field>

            <div className="flex items-center justify-between pt-2">
              {mode === "edit" ? (
                <Button type="button" variant="danger" size="sm" onClick={remove} disabled={busy}>
                  <Trash2 className="mr-1.5 size-4" /> Delete
                </Button>
              ) : (
                <div />
              )}
              <div className="flex items-center gap-3">
                {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
                <Button type="submit" disabled={busy || (mode === "edit" && !dirty)}>
                  {busy ? "Saving..." : mode === "create" ? "Create Connection" : "Save Changes"}
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
