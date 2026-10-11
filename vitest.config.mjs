import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
	// admin.jsx が読む EmDash の仮想モジュールは、テストではスタブに差し替える
	resolve: { alias: { "virtual:emdash/auth-providers": fileURLToPath(new URL("./test/support/auth-providers.js", import.meta.url)) } },
	test: { environment: "node", include: ["test/*.test.{js,mjs,jsx}", "scripts/test/*.test.mjs"] },
})
