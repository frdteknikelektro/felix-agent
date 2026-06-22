import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatTile({
  label,
  value,
  icon: Icon,
  accent,
  hint,
}: {
  label: string;
  value: number | string;
  icon: LucideIcon;
  accent?: "primary" | "warning" | "success";
  hint?: string;
}) {
  const accentClass =
    accent === "warning"
      ? "text-warning bg-warning/10"
      : accent === "success"
        ? "text-success bg-success/10"
        : "text-primary bg-primary/10";
  return (
    <Card className="flex items-center gap-4 p-4">
      <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-lg", accentClass)}>
        <Icon className="size-5" />
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-semibold leading-none tabular-nums">{value}</p>
        <p className="mt-1 truncate text-xs font-medium text-muted-foreground">{label}</p>
      </div>
      {hint && <span className="ml-auto text-xs text-muted-foreground">{hint}</span>}
    </Card>
  );
}
