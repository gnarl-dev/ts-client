import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // ES2022 runs natively on every runtime the package claims: Node 18, Bun,
  // Deno, current browsers and edge workers. Nothing is down-levelled, so the
  // output is the source minus its types.
  target: "es2022",
  tsconfig: "tsconfig.build.json",
  treeshake: true,
  splitting: false,
  minify: false,
});
