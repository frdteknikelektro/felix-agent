import { cn } from "@/lib/utils";
import { sourceLabel } from "@/lib/format";

const SOURCE_STYLES: Record<string, string> = {
  mattermost: "bg-[#0058cc]/15 text-[#3b82f6]",
  discord: "bg-[#5865f2]/15 text-[#7983f5]",
  slack: "bg-[#611f69]/15 text-[#c084fc]",
};

export function SourceBadge({ source, className }: { source: string; className?: string }) {
  const style = SOURCE_STYLES[source] ?? "bg-muted text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        style,
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {sourceLabel(source)}
    </span>
  );
}
