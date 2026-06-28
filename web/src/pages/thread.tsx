import { useParams, Link } from "react-router-dom";
import { ArrowLeft, ChevronDown, FileText, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/spinner";
import { EmptyState } from "@/components/empty-state";
import { SourceBadge } from "@/components/source-badge";
import { api, getList } from "@/lib/api";
import { useApiData } from "@/lib/use-api";
import { clockTime, fullTime, threadLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ChatMessage, SessionDetail } from "@/lib/types";

export function Thread() {
  const { threadKey = "" } = useParams();
  const encoded = encodeURIComponent(threadKey);
  const detail = useApiData(() => api.get<SessionDetail>(`/api/sessions/${encoded}`), [threadKey]);
  const messages = useApiData(() => getList<ChatMessage>(`/api/sessions/${encoded}/messages`), [threadKey]);

  return (
    <div className="space-y-4">
      <Link to="/sessions" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> All sessions
      </Link>

      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{threadLabel(threadKey)}</h2>
        {detail.data && <SourceBadge source={detail.data.summary.source} />}
        {detail.data?.summary.busy && <Badge variant="success">active</Badge>}
      </div>

      {detail.data?.summary.pendingPermissionId && (
        <Link
          to="/approvals"
          className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning"
        >
          <ShieldAlert className="size-4" />
          This thread is waiting on approval for{" "}
          <span className="font-medium">{detail.data.summary.pendingPermissionSkillId}</span> — review in Approvals.
        </Link>
      )}

      <Card>
        <CardContent className="p-4">
          {messages.loading && !messages.data ? (
            <LoadingState />
          ) : messages.error ? (
            <p className="py-6 text-sm text-danger">{messages.error}</p>
          ) : !messages.data || messages.data.length === 0 ? (
            <EmptyState title="No messages in this thread yet" />
          ) : (
            <div className="space-y-3">
              {messages.data.map((m) => (
                <Bubble key={m.id} message={m} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {detail.data && detail.data.artifacts.length > 0 && (
        <details className="group rounded-lg border border-border bg-card">
          <summary className="flex cursor-pointer list-none items-center gap-2 p-4 text-sm font-medium">
            <FileText className="size-4 text-muted-foreground" />
            Raw artifacts
            <Badge variant="outline">{detail.data.artifacts.length}</Badge>
            <ChevronDown className="ml-auto size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-3 border-t border-border p-4">
            {detail.data.artifacts.map((a) => (
              <details key={a.path} className="rounded-md border border-border bg-muted/40">
                <summary className="cursor-pointer p-2.5 text-xs font-medium">{a.label}</summary>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-border p-3 text-xs">
                  {a.content}
                </pre>
              </details>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  if (message.direction === "system") {
    return (
      <div className="flex justify-center">
        <div className="max-w-xl rounded-full bg-muted px-3 py-1.5 text-center text-xs text-muted-foreground">
          {message.text || message.kind}
        </div>
      </div>
    );
  }
  const outbound = message.direction === "outbound";
  const name = message.sender.display ?? message.sender.username ?? message.sender.id;
  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[78%] min-w-0", outbound && "items-end text-right")}>
        <div className="mb-0.5 flex items-center gap-2 text-xs text-muted-foreground" title={fullTime(message.at)}>
          {!outbound && <span className="font-medium text-foreground">{name}</span>}
          <span>{clockTime(message.at)}</span>
          {outbound && <span className="font-medium text-foreground">Felix</span>}
        </div>
        <div
          className={cn(
            "inline-block whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-left text-sm",
            outbound ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
          )}
        >
          {message.text}
        </div>
      </div>
    </div>
  );
}
