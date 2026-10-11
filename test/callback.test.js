import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as h from "./support/harness.js"

vi.mock("emdash", async () => ({ OptionsRepository: (await import("./support/harness.js")).OptionsRepository }))
vi.mock("@emdash-cms/auth/adapters/kysely", async () => {
	const { adapter } = await import("./support/harness.js")
	return { createKyselyAdapter: () => adapter }
})

const { GET: callback, BOOTSTRAP_KEY } = await import("../routes/callback.js")

const savedEnv = { ...process.env }
let warn, error
beforeEach(() => {
	h.reset()
	Object.assign(process.env, h.ENV)
	vi.stubGlobal("fetch", h.fakeFetch)
	warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	error = vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
	process.env = { ...savedEnv }
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

/** コールバックを 1 回実行し、リダイレクト先の URL を返す */
async function run({ code, sid = "s1", config = h.providerConfig(), query } = {}) {
	if (!h.sessionStore.has(sid)) h.seedState(sid)
	const session = h.mkSession(sid)
	const qs = query ?? `code=${code}&state=${currentState(sid)}`
	const to = await callback({
		request: new Request(`https://internal.local/_emdash/api/auth/discord/callback?${qs}`),
		session, redirect: (u) => u, locals: h.locals(config),
	})
	await session.persist()
	return { to, session, url: new URL(to, "https://cms.example.test") }
}
const currentState = (sid) => new Map(h.sessionStore.get(sid) ?? []).get("discord_oauth")?.state ?? "none"
const user = (email) => h.db.users.find((u) => u.email === email)

describe("初回 Admin（bootstrapFirstAdmin）", () => {
	it("既定（無効）では adminIds が空でも、初期セットアップ前でも Admin を付与しない", async () => {
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		const { to } = await run({ code: "alice" })
		expect(to).toBe("/_emdash/admin")
		expect(user("alice@example.test").role).toBe(10)
		expect(h.db.options.get("emdash:setup_complete")).toBeUndefined()
		expect(h.db.options.has(BOOTSTRAP_KEY)).toBe(false)
	})
	it("有効かつ初期セットアップ前なら最初の 1 人だけが Admin になり、セットアップ完了・警告ログが出る", async () => {
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		h.discord.users.bob = h.profile("200000000000000002", "bob@example.test")
		const config = h.providerConfig({ bootstrapFirstAdmin: true })
		await run({ code: "alice", config })
		expect(user("alice@example.test").role).toBe(50)
		expect(h.db.options.get("emdash:setup_complete")).toBe(true)
		expect(h.db.options.get("emdash:site_title")).toBe("Site")
		expect(warn.mock.calls.flat().join(" ")).toMatch(/bootstrapFirstAdmin/)
		await run({ code: "bob", sid: "s2", config })
		expect(user("bob@example.test").role).toBe(10)
	})
	it("環境変数 DISCORD_BOOTSTRAP_FIRST_ADMIN=1 でも有効になる（それ以外の値では無効）", async () => {
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		process.env.DISCORD_BOOTSTRAP_FIRST_ADMIN = "yes"
		await run({ code: "alice" })
		expect(user("alice@example.test").role).toBe(10)
		h.reset(); Object.assign(process.env, h.ENV)
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		process.env.DISCORD_BOOTSTRAP_FIRST_ADMIN = "1"
		await run({ code: "alice" })
		expect(user("alice@example.test").role).toBe(50)
	})
	it("初期セットアップ完了後は、有効でも Admin を付与しない（Admin 不在になっても同じ）", async () => {
		h.db.options.set("emdash:setup_complete", true)
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		await run({ code: "alice", config: h.providerConfig({ bootstrapFirstAdmin: true }) })
		expect(user("alice@example.test").role).toBe(10)
	})
	it("同時に 2 人がログインしても Admin になるのは 1 人だけ（原子的な獲得）", async () => {
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		h.discord.users.bob = h.profile("200000000000000002", "bob@example.test")
		const config = h.providerConfig({ bootstrapFirstAdmin: true })
		h.seedState("sa"); h.seedState("sb")
		await Promise.all([run({ code: "alice", sid: "sa", config }), run({ code: "bob", sid: "sb", config })])
		expect(h.db.users.map((u) => u.role).sort()).toEqual([10, 50])
	})
	it("adminIds に載った ID は bootstrap と無関係に Admin、載っていない人は既定ロール", async () => {
		h.discord.users.admin = h.profile(h.ADMIN_ID, "admin@example.test")
		h.discord.users.bob = h.profile("200000000000000002", "bob@example.test")
		const config = h.providerConfig({ adminIds: [h.ADMIN_ID], defaultRole: 30 })
		await run({ code: "bob", config })
		await run({ code: "admin", sid: "s2", config })
		expect(user("bob@example.test").role).toBe(30)
		expect(user("admin@example.test").role).toBe(50)
		expect(h.db.options.get("emdash:setup_complete")).toBe(true)
	})
	it("DISCORD_ADMIN_IDS に載った既存ユーザーは次回ログインで昇格する", async () => {
		h.discord.users.bob = h.profile("200000000000000002", "bob@example.test")
		await run({ code: "bob" })
		expect(user("bob@example.test").role).toBe(10)
		process.env.DISCORD_ADMIN_IDS = "200000000000000002"
		await run({ code: "bob", sid: "s2" })
		expect(user("bob@example.test").role).toBe(50)
	})
	it("adminIds に不正な ID があればログインさせない（黙って無視しない）", async () => {
		h.discord.users.bob = h.profile("200000000000000002", "bob@example.test")
		process.env.DISCORD_ADMIN_IDS = "12345"
		const { url } = await run({ code: "bob" })
		expect(url.searchParams.get("error")).toBe("provider_not_configured")
		expect(h.db.users).toEqual([])
	})
})

describe("エラー時の文言とログ", () => {
	const logs = () => JSON.stringify([...warn.mock.calls, ...error.mock.calls])
	it("?error=...&error_description=... の文言は画面にもログにも出さず、固定文言にする", async () => {
		const { url } = await run({ query: "error=access_denied&error_description=" + encodeURIComponent("Call +1-555 to restore access") })
		expect(url.searchParams.get("error")).toBe("oauth_denied")
		expect(url.searchParams.get("message")).toBe("Discord login was cancelled.")
		expect(url.toString() + logs()).not.toContain("555")
		expect(logs()).toContain("access_denied")
	})
	it("error パラメータが想定外の形式ならログには invalid と残す", async () => {
		await run({ query: "error=" + encodeURIComponent("<script>x") })
		expect(logs()).not.toContain("<script>")
		expect(logs()).toContain("invalid")
	})
	it("code / state 欠落は invalid_callback", async () => {
		const { url } = await run({ query: "code=abc" })
		expect(url.searchParams.get("error")).toBe("invalid_callback")
	})
	it("@emdash-cms/auth の OAuthError の message（内部の文言）は画面に出さない", async () => {
		// Discord ID でリンク済みだがユーザーが消えている → OAuthError("user_not_found", "Linked user not found")
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		h.db.accounts.push({ provider: "discord", providerAccountId: "200000000000000001", userId: "gone" })
		const { url } = await run({ code: "alice" })
		expect(url.searchParams.get("error")).toBe("user_not_found")
		expect(url.searchParams.get("message")).toBe("Your account was not found. It may have been deleted.")
		expect(url.toString()).not.toContain("Linked")
	})
	it("Discord の HTTP エラーはステータスをサーバーログに残し、シークレット・トークン・認可コードは出さない", async () => {
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		h.discord.faults.token = { status: 401 }
		const { url } = await run({ code: "alice" })
		expect(url.searchParams.get("error")).toBe("token_exchange_failed")
		expect(url.searchParams.get("message")).not.toMatch(/401/)
		expect(logs()).toContain("token_exchange_failed")
		expect(logs()).toContain("401")
		for (const secret of [h.ENV.DISCORD_CLIENT_SECRET, "tok-alice", "code=alice"]) expect(logs()).not.toContain(secret)
	})
	it("429 は rate_limited で、Retry-After をログに出し、画面には再試行を促す文言", async () => {
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		h.discord.faults.guilds = { status: 429, headers: { "Retry-After": "12" } }
		const { url } = await run({ code: "alice" })
		expect(url.searchParams.get("error")).toBe("rate_limited")
		expect(url.searchParams.get("message")).toMatch(/wait a moment/)
		expect(logs()).toContain("Retry-After")
		expect(logs()).toContain("12")
	})
	it("タイムアウトは discord_timeout", async () => {
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		h.discord.faults.me = "timeout"
		const { url } = await run({ code: "alice" })
		expect(url.searchParams.get("error")).toBe("discord_timeout")
	})
	it("文言は options.messages で上書きできる", async () => {
		h.discord.users.out = h.profile("200000000000000003", "out@example.test", { guilds: [{ id: h.OTHER_GUILD }] })
		const { url } = await run({ code: "out", config: h.providerConfig({ messages: { notGuildMember: "メンバー限定" } }) })
		expect(url.searchParams.get("error")).toBe("not_guild_member")
		expect(url.searchParams.get("message")).toBe("メンバー限定")
	})
	it("クライアント設定・guildId が無ければ、欠けている項目名をログに出して provider_not_configured", async () => {
		delete process.env.DISCORD_CLIENT_SECRET
		const { url } = await run({ code: "x", config: h.providerConfig({ guildId: undefined }) })
		expect(url.searchParams.get("error")).toBe("provider_not_configured")
		expect(logs()).toContain("DISCORD_CLIENT_SECRET")
		expect(logs()).toContain("guildId")
	})
	it("予期しない例外は oauth_error（固定文言）で、詳細はサーバーログだけに出す", async () => {
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		const orig = h.adapter.createUser
		h.adapter.createUser = async () => { throw new Error("db exploded") }
		try {
			const { url } = await run({ code: "alice" })
			expect(url.searchParams.get("error")).toBe("oauth_error")
			expect(url.toString()).not.toContain("exploded")
			expect(logs()).toContain("db exploded")
		} finally { h.adapter.createUser = orig }
	})
})

describe("アカウントの検証（ギルド・メール・無効化）", () => {
	it("ギルドに在籍していなければ not_guild_member で、ユーザーは作られない", async () => {
		h.discord.users.out = h.profile("200000000000000003", "out@example.test", { guilds: [{ id: h.OTHER_GUILD }] })
		const { url, session } = await run({ code: "out" })
		expect(url.searchParams.get("error")).toBe("not_guild_member")
		expect(h.db.users).toEqual([])
		expect(session.regenerated).toBe(0)
	})
	it("Discord のメールが未検証なら email_not_verified で拒否し、初回 Admin も消費しない", async () => {
		h.discord.users.d = h.profile("200000000000000004", "d@example.test", { verified: false })
		const { url } = await run({ code: "d", config: h.providerConfig({ bootstrapFirstAdmin: true }) })
		expect(url.searchParams.get("error")).toBe("email_not_verified")
		expect(h.db.users).toEqual([])
		expect(h.db.options.has(BOOTSTRAP_KEY)).toBe(false)
	})
	it("無効化済みのリンク済みユーザーは account_disabled で、セッションを発行しない", async () => {
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		await run({ code: "alice" })
		h.db.users[0].disabled = true
		const { url, session } = await run({ code: "alice", sid: "s2" })
		expect(url.searchParams.get("error")).toBe("account_disabled")
		expect(session.regenerated).toBe(0)
		expect(new Map(h.sessionStore.get("s2")).has("user")).toBe(false)
	})
	it("メールが一致する無効化済みユーザーには、リンク（OAuth アカウント行の作成）より前に拒否する", async () => {
		h.db.users.push({ id: "dis", email: "d@example.test", role: 30, disabled: true })
		h.discord.users.d = h.profile("200000000000000004", "d@example.test")
		const { url } = await run({ code: "d" })
		expect(url.searchParams.get("error")).toBe("account_disabled")
		expect(h.db.accounts).toEqual([])
	})
	it("事前確認の後で無効化済みユーザーにリンクされた場合も（並行操作）、作成・取得後の確認で拒否する", async () => {
		h.db.users.push({ id: "dis", email: "d@example.test", role: 30, disabled: true })
		h.discord.users.d = h.profile("200000000000000004", "d@example.test")
		const orig = h.adapter.getUserByEmail
		let first = true
		h.adapter.getUserByEmail = async (e) => { if (first) { first = false; return null } return orig(e) }
		try {
			const { url, session } = await run({ code: "d" })
			expect(url.searchParams.get("error")).toBe("account_disabled")
			expect(session.regenerated).toBe(0)
		} finally { h.adapter.getUserByEmail = orig }
	})
	it("成功時はセッション ID を再生成し、user を保存し、ログイン記録・表示名を更新する", async () => {
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		const { to, session } = await run({ code: "alice" })
		expect(to).toBe("/_emdash/admin")
		expect(session.regenerated).toBe(1)
		const u = user("alice@example.test")
		expect(new Map(h.sessionStore.get("s1")).get("user")).toEqual({ id: u.id })
		expect(u.data.discord).toMatchObject({ id: "200000000000000001", loginCount: 1 })
		expect(u.name).toBe("User 001")
	})
})

describe("接続先・公開 URL の検証（callback）", () => {
	it("DISCORD_BASE_URL が不正ならクライアントシークレットを送らずに provider_not_configured", async () => {
		process.env.DISCORD_BASE_URL = "http://evil.test"
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		const { url } = await run({ code: "alice" })
		expect(url.searchParams.get("error")).toBe("provider_not_configured")
		expect(h.discord.calls).toEqual([])
	})
	it("NODE_ENV=production で EMDASH_SITE_URL が無ければ provider_not_configured", async () => {
		process.env.NODE_ENV = "production"
		delete process.env.EMDASH_SITE_URL
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		const { url } = await run({ code: "alice" })
		expect(url.searchParams.get("error")).toBe("provider_not_configured")
		expect(h.discord.calls).toEqual([])
	})
	it("トークン交換の redirect_uri は EMDASH_SITE_URL から作る", async () => {
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		await run({ code: "alice" })
		const body = new URLSearchParams(h.discord.calls[0].init.body)
		expect(body.get("redirect_uri")).toBe("https://cms.example.test/_emdash/api/auth/discord/callback")
	})
})

describe("state（1 回限り・期限）と PKCE", () => {
	it("同じ state を 2 回目に使うと invalid_state（逐次の再送）", async () => {
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		const st = h.seedState("s1")
		expect((await run({ code: "alice" })).to).toBe("/_emdash/admin")
		const { url } = await run({ query: `code=alice&state=${st}` })
		expect(url.searchParams.get("error")).toBe("invalid_state")
	})
	it("state が一致しなくても保存済み state は破棄される（総当たりで再利用できない）", async () => {
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		const st = h.seedState("s1")
		expect((await run({ query: "code=alice&state=wrong" })).url.searchParams.get("error")).toBe("invalid_state")
		expect((await run({ query: `code=alice&state=${st}` })).url.searchParams.get("error")).toBe("invalid_state")
		expect(h.discord.calls).toEqual([])
	})
	it("10 分を過ぎた state は invalid_state", async () => {
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		h.sessionStore.set("s1", [["discord_oauth", { state: "old", at: Date.now() - 11 * 60 * 1000 }]])
		expect((await run({ query: "code=alice&state=old" })).url.searchParams.get("error")).toBe("invalid_state")
	})
	it("保存済みの verifier を code_verifier としてトークン交換に送る。verifier の無い（更新前の）state では送らない", async () => {
		h.discord.users.alice = h.profile("200000000000000001", "alice@example.test")
		h.seedState("s1", "st1", { verifier: "v".repeat(43) })
		await run({ code: "alice" })
		expect(new URLSearchParams(h.discord.calls[0].init.body).get("code_verifier")).toBe("v".repeat(43))
		h.discord.calls = []
		h.seedState("s2", "st2")
		await run({ code: "alice", sid: "s2" })
		expect(new URLSearchParams(h.discord.calls[0].init.body).has("code_verifier")).toBe(false)
	})
	it("login → モック Discord（PKCE を検証）→ callback が通しで成功する", async () => {
		const { startMockDiscord } = await import("./mock-discord.mjs")
		const { GET: login } = await import("../routes/login.js")
		const server = await startMockDiscord(0)
		vi.unstubAllGlobals() // 本物の fetch でモックに接続する
		try {
			process.env.DISCORD_BASE_URL = `http://127.0.0.1:${server.address().port}`
			process.env.DISCORD_CLIENT_SECRET = "mock-secret"
			const loginSession = h.mkSession("e2e")
			const authorize = await login({ request: new Request("https://internal.local/x"), session: loginSession, redirect: (u) => u, locals: h.locals() })
			await loginSession.persist()
			const res = await fetch(authorize, { redirect: "manual" })
			const back = new URL(res.headers.get("location"))
			expect(back.pathname).toBe("/_emdash/api/auth/discord/callback")
			const { to } = await run({ sid: "e2e", query: back.searchParams.toString() })
			expect(to).toBe("/_emdash/admin")
			expect(user("a@example.test").role).toBe(10)
			// verifier を改ざんするとモックがトークン交換を拒否する（PKCE が効いている）
			const s2 = h.mkSession("e2e-2")
			const authorize2 = await login({ request: new Request("https://internal.local/x"), session: s2, redirect: (u) => u, locals: h.locals() })
			await s2.persist()
			const saved = new Map(h.sessionStore.get("e2e-2")).get("discord_oauth")
			h.sessionStore.set("e2e-2", [["discord_oauth", { ...saved, verifier: "x".repeat(43) }]])
			const back2 = new URL((await fetch(authorize2, { redirect: "manual" })).headers.get("location"))
			expect((await run({ sid: "e2e-2", query: back2.searchParams.toString() })).url.searchParams.get("error")).toBe("token_exchange_failed")
		} finally { server.close() }
	})
})
