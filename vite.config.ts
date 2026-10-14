import { defineConfig } from "vite-plus";

// Build output, Tauri-generated files and vendored UI primitives are not ours to format or lint.
const ignorePatterns = [
  "**/dist/**",
  "**/node_modules/**",
  "packages/desktop/src-tauri/target/**",
  "packages/desktop/src-tauri/gen/**",
  "packages/desktop/src-tauri/icons/**",
  "docs/**",
];

export default defineConfig({
  fmt: { ignorePatterns },
  lint: {
    // The mod is Moddable runtime JS and sim-spike is a throwaway Bun script: neither type-checks as a normal package.
    ignorePatterns: [...ignorePatterns, "packages/stackchan-mod/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  // Pre-commit hook (.vite-hooks/pre-commit) runs `vp staged`; installed via the `prepare` script.
  staged: { "*.{js,mjs,ts,tsx,json}": "vp check --fix" },
  run: {
    cache: true,
  },
});
