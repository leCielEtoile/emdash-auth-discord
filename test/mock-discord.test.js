import { describe, it, expect, vi, afterEach } from "vitest"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { startMockDiscord, MOCK_HOST } from "./mock-discord.mjs"

const savedEnv = { ...process.env }
afterEach(() => { process.env = { ...savedEnv }; vi.restoreAllMocks() })
const script = fileURLToPath(new URL("./mock-discord.mjs", import.meta.url))

describe("mock-discord（テスト専用）", () => {
	it("127.0.0.1 にだけ bind する", async () => {
		const server = await startMockDiscord(0)
		try {
			expect(MOCK_HOST).toBe("127.0.0.1")
			expect(server.address().address).toBe("127.0.0.1")
		} finally { server.close() }
	})
	it("NODE_ENV=production では起動を拒否する（関数・CLI とも）", () => {
		process.env.NODE_ENV = "production"
		expect(() => startMockDiscord(0)).toThrowError(/production/)
		const r = spawnSync(process.execPath, [script], { env: { ...process.env, PORT: "0", NODE_ENV: "production" }, encoding: "utf8", timeout: 5000 })
		expect(r.status).not.toBe(0)
		expect(r.stderr).toMatch(/production/)
	})
	it("モックの token / users/@me / guilds でプラグインの lib が動く（DISCORD_BASE_URL=http://127.0.0.1:<port>）", async () => {
		const { exchangeCode, fetchMe, fetchAllGuilds, checkBaseUrl } = await import("../lib.js")
		const server = await startMockDiscord(0)
		try {
			const baseUrl = checkBaseUrl(`http://127.0.0.1:${server.address().port}`)
			const accessToken = await exchangeCode({ baseUrl, clientId: "c", clientSecret: "mock-secret", code: "code-a", redirectUri: "http://localhost/cb" })
			expect((await fetchMe({ baseUrl, accessToken })).username).toBe("alice_a")
			expect((await fetchAllGuilds({ baseUrl, accessToken })).length).toBe(2)
		} finally { server.close() }
	})
})
