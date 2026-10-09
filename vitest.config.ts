import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "conformance",
          include: ["test/conformance/**/*.test.ts"],
          environment: "node",
          globalSetup: ["test/conformance/global-setup.ts"],
          // One node, shared: run files one at a time so a test's cleanup
          // cannot race another file's assertions.
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
