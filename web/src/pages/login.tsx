import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";

export function Login() {
  const navigate = useNavigate();
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(secret);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "Incorrect secret." : "Login failed. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground">
            F
          </div>
          <div>
            <h1 className="text-xl font-semibold">Felix Owner Console</h1>
            <p className="text-sm text-muted-foreground">Sign in with the owner secret.</p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-card p-6 shadow-sm">
          <Input
            type="password"
            autoFocus
            autoComplete="current-password"
            placeholder="Owner secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy || !secret}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
