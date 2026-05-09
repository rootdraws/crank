import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * vitest config — workarounds for two ESM-interop bugs in @meteora-ag/dlmm@1.9.3:
 *
 * 1. dlmm's dist/index.mjs has a directory import:
 *      import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes"
 *    Node ESM rejects directory imports without an index.js suffix. Patched
 *    in-place at the dist file (see vagbuck.md), but we also alias here so a
 *    fresh `npm install` doesn't re-break tests until patch-package runs.
 *
 * 2. dlmm's ESM bundle does `import { BN } from "@coral-xyz/anchor"`. Vitest's
 *    resolver has trouble extracting named exports from anchor's CJS build.
 *    Force the ESM entry explicitly so named exports work.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@coral-xyz\/anchor\/dist\/cjs\/utils\/bytes$/,
        replacement: path.resolve(__dirname, 'node_modules/@coral-xyz/anchor/dist/cjs/utils/bytes/index.js'),
      },
      {
        find: /^@coral-xyz\/anchor$/,
        replacement: path.resolve(__dirname, 'node_modules/@coral-xyz/anchor/dist/esm/index.js'),
      },
    ],
  },
  test: {
    environment: 'node',
    // Pre-existing dlmm/anchor ESM-interop bug breaks bot.test.ts. The dlmm
    // dist file edit above unblocks the directory-import error; the deeper
    // CJS-named-export issue still bites. Excluded until either (a) dlmm
    // ships a working ESM build (1.10+), or (b) we migrate the test off
    // dlmm imports. Documented in vagbuck.md.
    exclude: ['**/node_modules/**', '**/dist/**', 'bot/bot.test.ts'],
  },
});
