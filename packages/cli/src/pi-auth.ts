// pi's own login file (`~/.pi/agent/auth.json`) as a pi-ai CredentialStore, so the orchestrator can use the
// subscription you signed in to with `pi` → `/login`. Writes (an OAuth refresh rotates the refresh token) take
// the same proper-lockfile lock pi takes on that file, so das and a running pi never refresh over each other.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

/** pi's auth file: `$PI_CODING_AGENT_DIR/auth.json`, else `~/.pi/agent/auth.json`. */
export const defaultPiAuthFile = (env: Record<string, string | undefined> = process.env) =>
  join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "auth.json");

/** pi waits this long for another holder of the lock, and treats an older lock as stale. */
const STALE_MS = 30_000;

export class PiAuthFile implements CredentialStore {
  constructor(readonly path: string) {}

  private load(): Record<string, Credential> {
    if (!existsSync(this.path)) return {};
    const text = readFileSync(this.path, "utf8").replace(/^﻿/, "");
    const data: unknown = text.trim() ? JSON.parse(text) : {};
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error(`invalid ${this.path}: expected an object`);
    return data as Record<string, Credential>;
  }

  private async locked<T>(fn: (data: Record<string, Credential>) => Promise<T>): Promise<T> {
    if (!existsSync(this.path)) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(this.path, "{}", { mode: 0o600 });
    }
    const deadline = Date.now() + STALE_MS;
    let release: (() => Promise<void>) | undefined;
    for (let delay = 10; !release; delay = Math.min(delay * 2, 1000)) {
      try {
        release = await lockfile.lock(this.path, { realpath: false, retries: 0, stale: STALE_MS });
      } catch (e: any) {
        if (e?.code !== "ELOCKED" || Date.now() > deadline) throw e;
        await Bun.sleep(delay);
      }
    }
    try {
      return await fn(this.load());
    } finally {
      await release().catch(() => {});
    }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.load()[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load()).map(([providerId, c]) => ({ providerId, type: c.type }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.locked(async (data) => {
      options?.signal?.throwIfAborted();
      const next = await fn(data[providerId]);
      if (next === undefined) return data[providerId];
      writeFileSync(this.path, JSON.stringify({ ...data, [providerId]: next }, null, 2), {
        mode: 0o600,
      });
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.locked(async (data) => {
      delete data[providerId];
      writeFileSync(this.path, JSON.stringify(data, null, 2), { mode: 0o600 });
    });
  }
}
