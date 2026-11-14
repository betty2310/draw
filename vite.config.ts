import { defineConfig } from "vite-plus";

export default defineConfig({
  // Prose in docs/ keeps its hand-written tables.
  fmt: { ignorePatterns: ["docs/**"] },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
