import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    reporters: "default",
    // Real Python scripts run against the live workspace store; give them room.
    testTimeout: 30_000,
    // The write endpoint mutates files — never run write tests in parallel files
    // against the same shared task store.
    fileParallelism: false,
    setupFiles: ["./test/setup.ts"],
  },
});
