// Compile the server into the Tauri sidecar binary: app/src-tauri/binaries/stack-chan-server-<host triple>
const triple = Bun.spawnSync(["rustc", "-vV"]).stdout.toString().match(/^host: (.+)$/m)?.[1];
if (!triple) throw new Error("cannot read host triple from `rustc -vV`");
const outfile = `app/src-tauri/binaries/stack-chan-server-${triple}`;
const p = Bun.spawnSync(["bun", "build", "--compile", "src/server.ts", "--outfile", outfile], { stdio: ["inherit", "inherit", "inherit"] });
process.exit(p.exitCode);
