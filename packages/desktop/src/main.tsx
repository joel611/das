import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import App from "./App.tsx";
import { applyTheme } from "@/lib/neon-theme.ts";
import { ThemeProvider } from "@/components/theme-provider.tsx";
import { Toaster } from "@/components/ui/sonner.tsx";

applyTheme();

// WebdriverIO bridge; only in the e2e build (`bun run e2e`).
if (import.meta.env.VITE_E2E) await import("@wdio/tauri-plugin");

// Polling keeps data fresh; a failed poll must not retry-storm a daemon that is down.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="dark">
        <App />
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
