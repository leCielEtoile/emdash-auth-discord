import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createHash } from "node:crypto"
import * as h from "./support/harness.js"
import { GET as login } from "../routes/login.js"

const savedEnv = { ...process.env }
let warn
beforeEach(() => {
	h.reset()
	Object.assign(process.env, h.ENV)
	warn = vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
	process.env = { ...savedEnv }
	vi.restoreAllMocks()
})

async function run({ config = h.providerConfig(), session = h.mkSession("s1") } = {}) {
	const to = await login({ request: new Request("https://internal.local/_emdash/api/auth/discord/login"), session, redirect: (u) => u, locals: h.locals(config) })
	await session?.persist()
	return new URL(to, "https://cms.example.test")
}
const logs = () => JSON.stringify(warn.mock.calls)

describe("login", () => {
	it("Discord の認可 URL へ、state をセッションに保存してリダイレクトする", async () => {
		const url = await run()
		expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize")
		expect(url.searchParams.get("client_id")).toBe("cid")
		expect(url.searchParams.get("redirect_uri")).toBe("https://cms.example.test/_emdash/api/auth/discord/callback")
		expect(url.searchParams.get("scope")).toBe("identify email guilds")
		const saved = new Map(h.sessionStore.get("s1")).get("discord_oauth")
		expect(saved.state).toBe(url.searchParams.get("state"))
		expect(typeof saved.at).toBe("number")
	})
	it.each([
		["DISCORD_CLIENT_ID", () => delete process.env.DISCORD_CLIENT_ID, h.providerConfig()],
		["DISCORD_CLIENT_SECRET", () => delete process.env.DISCORD_CLIENT_SECRET, h.providerConfig()],
		["guildId", () => {}, h.providerConfig({ guildId: undefined })],
	])("%s が無ければ開始せず provider_not_configured（欠けている項目名をログに出す）", async (name, unset, config) => {
		unset()
		const url = await run({ config })
		expect(url.pathname).toBe("/_emdash/admin/login")
		expect(url.searchParams.get("error")).toBe("provider_not_configured")
		expect(logs()).toContain(name)
		expect(h.sessionStore.has("s1")).toBe(false)
	})
	it("セッションが使えなければ server_error", async () => {
		const url = await run({ session: null })
		expect(url.searchParams.get("error")).toBe("server_error")
	})
	it("画面の文言は英語の既定、または options.messages の上書き", async () => {
		delete process.env.DISCORD_CLIENT_ID
		expect((await run()).searchParams.get("message")).toBe("Discord login is not configured. Please contact the site administrator.")
		expect((await run({ config: h.providerConfig({ messages: { providerNotConfigured: "未設定です" } }) })).searchParams.get("message")).toBe("未設定です")
	})
	it("DISCORD_BASE_URL が不正（平文の外部ホスト）なら開始しない", async () => {
		process.env.DISCORD_BASE_URL = "http://discord.test"
		const url = await run()
		expect(url.searchParams.get("error")).toBe("provider_not_configured")
		expect(logs()).toContain("DISCORD_BASE_URL")
	})
	it("NODE_ENV=production では DISCORD_BASE_URL に discord.com 以外を使えない", async () => {
		process.env.NODE_ENV = "production"
		process.env.DISCORD_BASE_URL = "https://discord.test"
		expect((await run()).searchParams.get("error")).toBe("provider_not_configured")
		process.env.DISCORD_BASE_URL = "https://discord.com"
		expect((await run({ session: h.mkSession("s2") })).origin).toBe("https://discord.com")
	})
	it("EMDASH_SITE_URL が無い場合: 開発時はリクエストの origin、production ではエラー、EmDash の siteUrl があればそれを使う", async () => {
		delete process.env.EMDASH_SITE_URL
		expect((await run()).searchParams.get("redirect_uri")).toBe("https://internal.local/_emdash/api/auth/discord/callback")
		process.env.NODE_ENV = "production"
		const url = await run({ session: h.mkSession("s2") })
		expect(url.searchParams.get("error")).toBe("provider_not_configured")
		expect(logs()).toContain("EMDASH_SITE_URL")
		const loc = h.locals(); loc.emdash.config.siteUrl = "https://site.example.test"
		const to = await login({ request: new Request("https://internal.local/x"), session: h.mkSession("s3"), redirect: (u) => u, locals: loc })
		expect(new URL(to).searchParams.get("redirect_uri")).toBe("https://site.example.test/_emdash/api/auth/discord/callback")
	})
	it("EMDASH_SITE_URL が http(s) の URL でなければエラー", async () => {
		process.env.EMDASH_SITE_URL = "javascript:alert(1)"
		expect((await run()).searchParams.get("error")).toBe("provider_not_configured")
	})
	it("PKCE: verifier をセッションに保存し、その S256 を code_challenge として送る", async () => {
		const url = await run()
		const saved = new Map(h.sessionStore.get("s1")).get("discord_oauth")
		expect(saved.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(saved.verifier).digest("base64url"))
		expect(url.searchParams.get("code_challenge_method")).toBe("S256")
	})
})
