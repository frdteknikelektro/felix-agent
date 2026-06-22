import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { ArrowLeft, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LoadingState } from "@/components/ui/spinner";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { useApiData } from "@/lib/use-api";
import { useUnsavedGuard } from "@/lib/use-unsaved";
import { linesToList, listToText } from "@/lib/text";
import type { SkillRecord } from "@/lib/types";

export function SkillEditor() {
  const { skillId = "" } = useParams();
  const { toast } = useToast();
  const { data, error, loading } = useApiData(() => api.get<SkillRecord>(`/api/skills/${encodeURIComponent(skillId)}`), [skillId]);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [permissions, setPermissions] = useState("");
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const { guardedNavigate } = useUnsavedGuard(dirty);

  useEffect(() => {
    if (!data) return;
    setName(data.name ?? "");
    setDescription(data.description ?? "");
    setPermissions(listToText(data.permissions));
    setBody(data.body ?? "");
    setDirty(false);
  }, [data]);

  function edit<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setDirty(true);
    };
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put(`/api/skills/${encodeURIComponent(skillId)}`, {
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        permissions: linesToList(permissions),
        body,
      });
      setDirty(false);
      toast({ title: "Skill saved", description: skillId, variant: "success" });
    } catch (err) {
      toast({ title: "Save failed", description: (err as Error).message, variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete skill "${skillId}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.del(`/api/skills/${encodeURIComponent(skillId)}`);
      setDirty(false);
      toast({ title: "Skill deleted", description: skillId });
      guardedNavigate("/skills");
    } catch (err) {
      toast({ title: "Delete failed", description: (err as Error).message, variant: "error" });
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <button
        onClick={() => guardedNavigate("/skills")}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> All skills
      </button>

      {loading && !data ? (
        <LoadingState />
      ) : error ? (
        <Card>
          <CardContent className="py-6 text-sm text-danger">{error}</CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-5">
            <form onSubmit={save} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="ID">
                  <Input value={skillId} readOnly />
                </Field>
                <Field label="Name">
                  <Input value={name} onChange={(e) => edit(setName)(e.target.value)} />
                </Field>
              </div>
              <Field label="Description">
                <Input value={description} onChange={(e) => edit(setDescription)(e.target.value)} />
              </Field>
              <Field label="Permissions (one per line)">
                <Textarea value={permissions} onChange={(e) => edit(setPermissions)(e.target.value)} rows={4} />
              </Field>
              <Field label="Body (SKILL.md)">
                <Textarea value={body} onChange={(e) => edit(setBody)(e.target.value)} rows={16} className="font-mono text-xs" />
              </Field>
              <div className="flex items-center justify-between">
                <Button type="button" variant="danger" disabled={busy} onClick={remove}>
                  <Trash2 /> Delete
                </Button>
                <div className="flex items-center gap-3">
                  {dirty && <span className="text-xs text-warning">Unsaved changes</span>}
                  <Button type="submit" disabled={busy || !dirty}>
                    {busy ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
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
