import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
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
import type { ContactRecord } from "@/lib/types";

const SOURCES = ["mattermost", "discord", "slack", "whatsapp", "telegram"];

export function ContactEditor({ mode }: { mode: "create" | "edit" }) {
  return mode === "create" ? <CreateContact /> : <EditContact />;
}

function EditContact() {
  const params = useParams();
  const source = params.source ?? "";
  const userId = params["*"] ?? "";
  const { toast } = useToast();
  const { data, error, loading } = useApiData(
    () => api.get<ContactRecord>(`/api/contacts/${source}/${userId}`),
    [source, userId],
  );

  const [display, setDisplay] = useState("");
  const [username, setUsername] = useState("");
  const [permissions, setPermissions] = useState("");
  const [notes, setNotes] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const { guardedNavigate } = useUnsavedGuard(dirty);

  useEffect(() => {
    if (!data) return;
    setDisplay(data.display ?? "");
    setUsername(data.username ?? "");
    setPermissions(listToText(data.allowed_permissions));
    setNotes(data.notes ?? "");
    setDirty(false);
  }, [data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put(`/api/contacts/${source}/${userId}`, {
        display: display.trim() || undefined,
        username: username.trim() || undefined,
        allowed_permissions: linesToList(permissions),
        notes: notes.trim() || undefined,
      });
      setDirty(false);
      toast({ title: "Contact saved", description: `${source}:${userId}`, variant: "success" });
    } catch (err) {
      toast({ title: "Save failed", description: (err as Error).message, variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <EditorShell onBack={() => guardedNavigate("/contacts")}>
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
                <Field label="Source">
                  <Input value={source} readOnly />
                </Field>
                <Field label="User ID">
                  <Input value={userId} readOnly />
                </Field>
                <Field label="Display name">
                  <Input value={display} onChange={(e) => { setDisplay(e.target.value); setDirty(true); }} />
                </Field>
                <Field label="Username">
                  <Input value={username} onChange={(e) => { setUsername(e.target.value); setDirty(true); }} />
                </Field>
              </div>
              <Field label="Allowed permissions (one per line)">
                <Textarea value={permissions} onChange={(e) => { setPermissions(e.target.value); setDirty(true); }} rows={4} />
              </Field>
              <Field label="Notes">
                <Textarea value={notes} onChange={(e) => { setNotes(e.target.value); setDirty(true); }} rows={3} />
              </Field>
              <div className="flex items-center justify-end gap-3">
                {dirty && <span className="text-xs text-warning">Unsaved changes</span>}
                <Button type="submit" disabled={busy || !dirty}>
                  {busy ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </EditorShell>
  );
}

function CreateContact() {
  const { toast } = useToast();
  const [source, setSource] = useState(SOURCES[0]!);
  const [userId, setUserId] = useState("");
  const [display, setDisplay] = useState("");
  const [username, setUsername] = useState("");
  const [permissions, setPermissions] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const dirty = Boolean(userId || display || username || permissions || notes);
  // Suppress the guard while submitting — a successful create navigates on its own.
  const { guardedNavigate } = useUnsavedGuard(busy ? false : dirty);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/api/contacts/${source}/${userId.trim()}`, {
        display: display.trim() || undefined,
        username: username.trim() || undefined,
        allowed_permissions: linesToList(permissions),
        notes: notes.trim() || undefined,
      });
      toast({ title: "Contact created", description: `${source}:${userId.trim()}`, variant: "success" });
      // Raw navigate (not guarded): the create succeeded, so there is nothing to discard.
      navigate(`/contacts/${source}/${userId.trim()}`);
    } catch (err) {
      const msg = (err as Error).message === "contact_exists" ? "That contact already exists." : (err as Error).message;
      toast({ title: "Could not create contact", description: msg, variant: "error" });
      setBusy(false);
    }
  }

  return (
    <EditorShell onBack={() => guardedNavigate("/contacts")}>
      <Card>
        <CardContent className="p-5">
          <form onSubmit={create} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Source">
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="User ID">
                <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="platform user id" required />
              </Field>
              <Field label="Display name">
                <Input value={display} onChange={(e) => setDisplay(e.target.value)} />
              </Field>
              <Field label="Username">
                <Input value={username} onChange={(e) => setUsername(e.target.value)} />
              </Field>
            </div>
            <Field label="Allowed permissions (one per line)">
              <Textarea value={permissions} onChange={(e) => setPermissions(e.target.value)} rows={4} />
            </Field>
            <Field label="Notes">
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" disabled={busy || !userId.trim()}>
                {busy ? "Creating…" : "Create contact"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </EditorShell>
  );
}

function EditorShell({ onBack, children }: { onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> All contacts
      </button>
      {children}
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
