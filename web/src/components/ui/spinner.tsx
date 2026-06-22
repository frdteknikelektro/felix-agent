import { cn } from "@/lib/utils";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        "inline-block size-5 rounded-full border-2 border-border border-t-primary",
        className,
      )}
      style={{ animation: "felix-spin 0.7s linear infinite" }}
    />
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
      <Spinner />
      {label}
    </div>
  );
}
