import { describe, it, expect, afterEach } from "vitest"
import { existsSync } from "node:fs"
import { discord } from "../index.js"

const G = "100000000000000001"
const savedEnv = { ...process.env }
afterEach(() => { process.env = { ...savedEnv } })

describe("discord()（プロバイダ記述子）", () => {
	it("id・ルート・公開ルート・実在するエントリポイントを返す", () => {
		const d = discord({ guildId: G })
		expect(d.id).toBe("discord")
		expect(d.routes.map((r) => r.pattern)).toEqual(["/_emdash/api/auth/discord/login", "/_emdash/api/auth/discord/callback"])
		expect(d.publicRoutes).toEqual(["/_emdash/api/auth/discord/"])
		for (const f of [d.adminEntry, ...d.routes.map((r) => r.entrypoint)]) expect(existsSync(f)).toBe(true)
	})
	it("既定ロールは最小権限の 10", () => {
		expect(discord({ guildId: G }).config.defaultRole).toBe(10)
	})
	it("不正なオプションは呼び出し時に例外（起動時に気付ける）", () => {
		expect(() => discord({ guildId: G, defaultRole: 50 })).toThrowError(/defaultRole/)
		expect(() => discord({ guildId: Number(G) })).toThrowError(/guildId/)
	})
	it("呼び出し時点の DISCORD_ADMIN_IDS も検証する", () => {
		process.env.DISCORD_ADMIN_IDS = "not-an-id"
		expect(() => discord({ guildId: G })).toThrowError(/DISCORD_ADMIN_IDS/)
	})
	it("呼び出し時点の DISCORD_BASE_URL も検証する（production ではモックを指せない）", () => {
		process.env.DISCORD_BASE_URL = "http://discord.test"
		expect(() => discord({ guildId: G })).toThrowError(/DISCORD_BASE_URL/)
		process.env.DISCORD_BASE_URL = "http://127.0.0.1:4400"
		expect(() => discord({ guildId: G })).not.toThrow()
		process.env.NODE_ENV = "production"
		expect(() => discord({ guildId: G })).toThrowError(/DISCORD_BASE_URL/)
	})
})
