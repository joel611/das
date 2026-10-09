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
    ignorePatterns,
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
