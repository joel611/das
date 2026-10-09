import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SessionState } from "@/lib/types";

const STYLE: Record<SessionState, string> = {
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  waiting: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  done: "bg-green-500/15 text-green-600 dark:text-green-400",
  error: "bg-red-500/15 text-red-600 dark:text-red-400",
  idle: "bg-muted text-muted-foreground",
};

export function StateBadge({ state }: { state: SessionState }) {
  return (
    <Badge variant="secondary" className={cn("capitalize", STYLE[state])}>
      {state}
    </Badge>
  );
}
