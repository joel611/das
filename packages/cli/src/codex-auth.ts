// The Codex CLI's login file (`~/.codex/auth.json`) as a pi-ai CredentialStore, so the orchestrator can use the
// ChatGPT subscription you signed in to with `codex login`. Codex stores `tokens.{access,refresh,id}_token` and
// `account_id`; pi-ai's `openai-codex` provider uses the same OAuth client, so it can refresh these tokens and we
// write the rotated ones back into the same file, leaving every other field alone.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

/** The pi-ai provider id these credentials belong to. */
export const CODEX_PROVIDER = "openai-codex";

/** Codex's auth file: `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`. */
export const defaultCodexAuthFile = (env: Record<string, string | undefined> = process.env) =>
  join(env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");

type CodexFile = {
  last_refresh?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  [k: string]: unknown;
};

/** `exp` (seconds) of a JWT, as epoch ms; 0 (already expired) when unreadable so pi-ai refreshes it. */
function jwtExpiryMs(token: string): number {
  try {
    const exp = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()).exp;
    return typeof exp === "number" ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export class CodexAuthFile implements CredentialStore {
  constructor(readonly path: string) {}

  private load(): CodexFile {
    if (!existsSync(this.path)) return {};
    const text = readFileSync(this.path, "utf8").replace(/^﻿/, "");
    const data: unknown = text.trim() ? JSON.parse(text) : {};
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error(`invalid ${this.path}: expected an object`);
    return data as CodexFile;
  }

  private credential(file: CodexFile): Credential | undefined {
    const t = file.tokens;
    if (!t?.access_token || !t.refresh_token) return undefined;
    return {
      type: "oauth",
      access: t.access_token,
      refresh: t.refresh_token,
      expires: jwtExpiryMs(t.access_token),
      ...(t.account_id ? { accountId: t.account_id } : {}),
    } as Credential;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return providerId === CODEX_PROVIDER ? this.credential(this.load()) : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return this.credential(this.load()) ? [{ providerId: CODEX_PROVIDER, type: "oauth" }] : [];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (providerId !== CODEX_PROVIDER) return undefined;
    const file = this.load();
    const current = this.credential(file);
    options?.signal?.throwIfAborted();
    const next = await fn(current);
    if (next === undefined) return current;
    if (next.type !== "oauth") throw new Error("codex auth.json only holds an OAuth login");
    const { access, refresh, accountId } = next as Credential & {
      access: string;
      refresh: string;
      accountId?: string;
    };
    const merged: CodexFile = {
      ...file,
      last_refresh: new Date().toISOString(),
      tokens: {
        ...file.tokens,
        access_token: access,
        refresh_token: refresh,
        ...(accountId ? { account_id: accountId } : {}),
      },
    };
    // Write beside and rename, so a crash never leaves Codex a half-written login.
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.das-${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    return next;
  }

  /** Never signs Codex out; that is `codex logout`. */
  async delete(): Promise<void> {}
}
