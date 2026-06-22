import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/workspace/**", "**/node_modules/**", "**/dist/**"],
  },
});
