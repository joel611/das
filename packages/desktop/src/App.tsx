import { useState } from "react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePoll } from "@/hooks/use-poll";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Console } from "@/views/console";
import { Overview } from "@/views/overview";
import { Settings } from "@/views/settings";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "console", label: "Console" },
  { id: "settings", label: "Settings" },
] as const;

type Tab = (typeof TABS)[number]["id"];

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const state = usePoll(api.state, 2000);
  const online = !!state.data;

  return (
    <div className="mx-auto flex min-h-svh max-w-5xl flex-col gap-4 p-4">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Stack-chan</h1>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <span className={cn("size-2 rounded-full", online ? "bg-green-500" : "bg-red-500")} />
          {online ? `daemon: ${state.data?.display.headline}` : "daemon not running"}
        </span>
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="ml-auto">
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>
      {/* All views stay mounted so the console conversation survives a tab switch. */}
      <main>
        <div hidden={tab !== "overview"}>
          <Overview />
        </div>
        <div hidden={tab !== "console"}>
          <Console />
        </div>
        <div hidden={tab !== "settings"}>
          <Settings />
        </div>
      </main>
    </div>
  );
}
