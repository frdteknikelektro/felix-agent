import { useState } from "react";
import { Check, ShieldCheck, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SourceBadge } from "@/components/source-badge";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import type { ApprovalRecord } from "@/lib/types";

const STATUS_VARIANT = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
} as const;

export function ApprovalCard({
  approval,
  onDecided,
}: {
  approval: ApprovalRecord;
  onDecided?: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const requester = approval.requester.display ?? approval.requester.username ?? approval.requester.id;

  async function decide(action: "approve" | "reject", scope?: "once" | "always") {
    setBusy(true);
    try {
      await api.post(
        `/api/approvals/${encodeURIComponent(approval.id)}/${action}`,
        scope ? { scope } : undefined,
      );
      toast({
        title: action === "reject" ? "Request rejected" : `Approved (${scope})`,
        description: `${approval.skillId} for ${requester}`,
        variant: action === "reject" ? "default" : "success",
      });
      onDecided?.();
    } catch (err) {
      toast({ title: "Action failed", description: (err as Error).message, variant: "error" });
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="size-4 text-warning" />
        <span className="font-medium">{approval.skillId}</span>
        <SourceBadge source={approval.source} />
        {approval.status !== "pending" && (
          <Badge variant={STATUS_VARIANT[approval.status]}>{approval.status}</Badge>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{timeAgo(approval.requestedAt)}</span>
      </div>

      <p className="mt-2 text-sm">
        <span className="text-muted-foreground">Requested by</span> {requester}
      </p>
      {approval.reason && <p className="mt-1 text-sm text-muted-foreground">{approval.reason}</p>}

      {approval.permissions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {approval.permissions.map((p) => (
            <Badge key={p} variant="outline">
              {p}
            </Badge>
          ))}
        </div>
      )}

      {approval.status === "pending" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="success" disabled={busy} onClick={() => decide("approve", "once")}>
            <Check /> Once
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => decide("approve", "always")}>
            <Check /> Always
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => decide("reject")}>
            <X /> Reject
          </Button>
        </div>
      )}
    </div>
  );
}
