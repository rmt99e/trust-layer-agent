import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The examples import "trust-layer-agent" (the built package). Tests run them against src/ instead, so no build is needed.
export default defineConfig({
  resolve: { alias: [
    { find: /^trust-layer-agent$/, replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
    { find: /^trust-layer-agent\/postgres$/, replacement: fileURLToPath(new URL("./src/stores/postgres.ts", import.meta.url)) },
  ] },
});
