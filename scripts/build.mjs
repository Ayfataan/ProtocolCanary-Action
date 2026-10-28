// Bundles src/main.ts into a single dist/index.js the Action runs from
// directly, so consumers never run `npm install`/`npm run build` inside
// their own workflow (see CONTRIBUTING.md).
//
// esbuild, not @vercel/ncc: the pinned @actions/* packages (core 3.x,
// artifact 6.x) ship as ESM-only. ncc's webpack-based bundler cannot
// bundle an ESM-only dependency into a CommonJS `runs.using: node24`
// action (it emits a "Cannot find module" stub at runtime); esbuild
// handles ESM-into-CJS interop correctly.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  minify: true,
  sourcemap: true,
  legalComments: "linked",
  preserveSymlinks: true,
});

console.log("Built dist/index.js");
