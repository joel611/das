import type { Integration, Worker } from "../worker";
import { installPi, piStatus, uninstallPi } from "./extension";
import { cancelPi, sendPi, spawnPi } from "./spawn";

/** pi (`@earendil-works/pi-coding-agent`): `pi -p` in a das worktree, an extension in `<piDir>/extensions/`. */
export function createPiWorker({ dir }: { dir?: string } = {}): Worker {
  const integration: Integration | undefined = dir
    ? {
        status: (port) => piStatus({ piDir: dir, port }),
        install: (port) => installPi({ piDir: dir, port }),
        uninstall: () => uninstallPi({ piDir: dir }),
      }
    : undefined;
  return { id: "pi", spawn: spawnPi, send: sendPi, cancel: cancelPi, integration };
}
