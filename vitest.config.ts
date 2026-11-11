import { cloudflareTest } from "@cloudflare/vitest-plugin";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    agents(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
          POLICY_AUD: "test-audience"
        }
      }
    })
  ],
  test: { include: ["test/**/*.test.ts"] }
});
