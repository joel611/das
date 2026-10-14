import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Entry, TranscriptFormat } from "../../usage";

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Parse one Claude Code transcript line; null unless it is an assistant message with usage. */
export function parseLine(line: string, session: string): Entry | null {
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  const m = d?.message;
  if (d?.type !== "assistant" || !m?.usage || typeof m.id !== "string") return null;
  const at = Date.parse(d.timestamp);
  if (!Number.isFinite(at) || m.model === "<synthetic>") return null;
  return {
    id: m.id,
    session,
    at,
    model: String(m.model ?? "unknown"),
    input: n(m.usage.input_tokens),
    output: n(m.usage.output_tokens),
    cacheCreate: n(m.usage.cache_creation_input_tokens),
    cacheRead: n(m.usage.cache_read_input_tokens),
  };
}

/**
 * Transcripts live at `<claudeDir>/projects/<project>/<session>.jsonl`, which is what hook events point
 * at (`transcript_path`). Subagent transcripts live deeper and are not reported by hooks, so backfill
 * skips them too. Without `backfill` nothing is listed at startup (tests and bare servers stay off the
 * real directory).
 */
export function claudeTranscripts(root: string, backfill = true): TranscriptFormat {
  return {
    root,
    parseLine,
    recent: backfill
      ? async (since) => {
          const found: { session: string; path: string }[] = [];
          for (const proj of await readdir(root, { withFileTypes: true }).catch(() => [])) {
            if (!proj.isDirectory()) continue;
            const dir = join(root, proj.name);
            for (const f of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
              if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
              const path = join(dir, f.name);
              const st = await stat(path).catch(() => null);
              if (st && st.mtimeMs >= since)
                found.push({ session: f.name.slice(0, -".jsonl".length), path });
            }
          }
          return found;
        }
      : undefined,
  };
}
