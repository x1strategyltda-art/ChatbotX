import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import tsconfigPaths from "vite-tsconfig-paths"
import { defineConfig, type ViteUserConfig } from "vitest/config"

const COVERAGE_THRESHOLD = 80

// Self-contained config — does NOT `import "./react"` / `import "./node"`.
// Transitive `.ts` imports break under Node ESM when builder loads
// vitest.config.ts (vite only transforms the entry file, not the package
// graph). Inlining the merge avoids the resolver fallthrough.

const setupEnvPath = fileURLToPath(new URL("./setup-env.ts", import.meta.url))
const setupMswPath = fileURLToPath(new URL("./setup-msw.ts", import.meta.url))

/**
 * Vitest preset for the Next.js builder app — jsdom env + React plugin +
 * Next-aligned resolve conditions.
 *
 * Tests for pure server-only code (server actions, route handlers) should add
 * `// @vitest-environment node` at the top of the file to opt out of jsdom.
 */
const config: ViteUserConfig = defineConfig({
  plugins: [tsconfigPaths(), react()],
  resolve: {
    conditions: ["browser", "module", "import", "default"],
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: ["**/*.{test,spec}.{ts,tsx}"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
    ],
    setupFiles: [setupEnvPath, setupMswPath],
    clearMocks: true,
    restoreMocks: true,
    server: {
      deps: {
        inline: [/^next-intl/],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.d.ts",
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "**/__tests__/**",
        "**/dist/**",
      ],
      thresholds: process.env.VITEST_SKIP_COVERAGE_THRESHOLDS
        ? undefined
        : {
            lines: COVERAGE_THRESHOLD,
            functions: COVERAGE_THRESHOLD,
            branches: COVERAGE_THRESHOLD,
            statements: COVERAGE_THRESHOLD,
          },
    },
  },
})

export default config
