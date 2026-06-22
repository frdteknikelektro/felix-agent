import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Search, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LoadingState } from "@/components/ui/spinner";
import { EmptyState } from "@/components/empty-state";
import { useToast } from "@/components/toast";
import { api, getList } from "@/lib/api";
import { useApiData } from "@/lib/use-api";
import { linesToList } from "@/lib/text";
import type { SkillRecord } from "@/lib/types";

export function Skills() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data, error, loading, reload } = useApiData(() => getList<SkillRecord>("/api/skills"));
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const items = useMemo(() => {
    const q = query.toLowerCase();
    return (data ?? []).filter(
      (s) => !q || s.id.toLowerCase().includes(q) || (s.name ?? "").toLowerCase().includes(q),
    );
  }, [data, query]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search skills…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Button onClick={() => setCreating((c) => !c)}>
          <Plus /> New skill
        </Button>
      </div>

      {creating && (
        <CreateSkillForm
          onCancel={() => setCreating(false)}
          onCreated={(id) => {
            toast({ title: "Skill created", description: id, variant: "success" });
            navigate(`/skills/${encodeURIComponent(id)}`);
          }}
          onError={(msg) => toast({ title: "Could not create skill", description: msg, variant: "error" })}
        />
      )}

      {loading && !data ? (
        <LoadingState />
      ) : error ? (
        <Card>
          <CardContent className="py-6 text-sm text-danger">{error}</CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState icon={Sparkles} title="No skills" description="Create one to grant Felix new abilities." />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="divide-y divide-border p-0">
            {items.map((s) => (
              <button
                key={s.id}
                onClick={() => navigate(`/skills/${encodeURIComponent(s.id)}`)}
                className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
              >
                <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{s.name || s.id}</p>
                  <p className="truncate text-xs text-muted-foreground">{s.description || s.id}</p>
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  {s.permissions.slice(0, 3).map((p) => (
                    <Badge key={p} variant="outline">
                      {p}
                    </Badge>
                  ))}
                  {s.permissions.length > 3 && <Badge variant="outline">+{s.permissions.length - 3}</Badge>}
                </div>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      <p className="text-right text-xs text-muted-foreground">
        <button onClick={reload} className="hover:text-foreground">
          Refresh
        </button>
      </p>
    </div>
  );
}

function CreateSkillForm({
  onCancel,
  onCreated,
  onError,
}: {
  onCancel: () => void;
  onCreated: (id: string) => void;
  onError: (msg: string) => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [permissions, setPermissions] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/api/skills", {
        id: id.trim(),
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        permissions: linesToList(permissions),
        body,
      });
      onCreated(id.trim());
    } catch (err) {
      onError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-4">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="ID (a–z, 0–9, . _ -)">
              <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="deploy-helper" required />
            </Field>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Deploy helper" />
            </Field>
          </div>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Permissions (one per line)">
            <Textarea value={permissions} onChange={(e) => setPermissions(e.target.value)} rows={3} />
          </Field>
          <Field label="Body (SKILL.md)">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} className="font-mono text-xs" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !id.trim()}>
              {busy ? "Creating…" : "Create skill"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
