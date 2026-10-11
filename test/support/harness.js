// routes/*.js を駆動するためのテスト用ハーネス。
// 実物の @emdash-cms/auth（findOrCreateOAuthUser・Role・OAuthError）を使い、DB アダプタ・OptionsRepository・
// Discord API（globalThis.fetch）・Astro セッションだけをインメモリで模擬する。
// 各操作の前に短い待ちを入れて、実 DB の await 境界（並行リクエストの割り込み）を再現する。

export const GUILD = "100000000000000001"
export const OTHER_GUILD = "100000000000000999"
export const ADMIN_ID = "200000000000000099"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LAT = 2

export const db = { users: [], accounts: [], options: new Map() }

export const adapter = {
	async getOAuthAccount(provider, id) { await sleep(LAT); return db.accounts.find((a) => a.provider === provider && a.providerAccountId === id) ?? null },
	async getUserById(id) { await sleep(LAT); return db.users.find((u) => u.id === id) ?? null },
	async getUserByEmail(email) { await sleep(LAT); return db.users.find((u) => u.email === email.toLowerCase()) ?? null },
	async createOAuthAccount(a) { await sleep(LAT); db.accounts.push(a) },
	async createUser(u) {
		await sleep(LAT)
		const user = { id: "u" + (db.users.length + 1), disabled: false, data: null, ...u, email: u.email.toLowerCase() }
		db.users.push(user)
		return user
	},
	async updateUser(id, patch) { await sleep(LAT); Object.assign(db.users.find((u) => u.id === id), patch) },
}

/** emdash の OptionsRepository の模擬（setIfAbsent は INSERT ... ON CONFLICT DO NOTHING 相当で原子的） */
export class OptionsRepository {
	async get(k) { await sleep(LAT); return db.options.has(k) ? db.options.get(k) : null }
	async set(k, v) { await sleep(LAT); db.options.set(k, v) }
	async setIfAbsent(k, v) {
		await sleep(LAT)
		if (db.options.has(k)) return false
		db.options.set(k, v)
		return true
	}
}

// ---- Discord 模擬 ----
export const discord = {
	users: {},
	/** エンドポイントごとの異常系: { token|me|guilds: { status, headers } | "timeout" | "network" } */
	faults: {},
	calls: [],
}
export const profile = (id, email, { verified = true, guilds = [{ id: GUILD }] } = {}) => ({
	profile: { id, username: "user" + id.slice(-3), global_name: "User " + id.slice(-3), avatar: null, email, verified, locale: "ja" },
	guilds,
})

const res = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } })
function fault(kind, signal) {
	const f = discord.faults[kind]
	if (!f) return null
	if (f === "timeout") return Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
	if (f === "network") return Promise.reject(new TypeError("fetch failed"))
	return Promise.resolve(res(f.status, { message: "error" }, f.headers))
}

export async function fakeFetch(url, init = {}) {
	const u = new URL(url)
	discord.calls.push({ url: u, init })
	if (u.pathname === "/api/oauth2/token") {
		const f = fault("token", init.signal); if (f) return f
		const code = new URLSearchParams(init.body).get("code")
		if (!discord.users[code]) return res(400, { error: "invalid_grant" })
		return res(200, { access_token: "tok-" + code, token_type: "Bearer" })
	}
	const who = (init.headers?.Authorization ?? "").replace("Bearer tok-", "")
	if (!discord.users[who]) return res(401, { message: "401: Unauthorized" })
	if (u.pathname === "/api/users/@me") { const f = fault("me", init.signal); if (f) return f; return res(200, discord.users[who].profile) }
	if (u.pathname === "/api/users/@me/guilds") { const f = fault("guilds", init.signal); if (f) return f; return res(200, discord.users[who].guilds) }
	return res(404, {})
}

// ---- Astro セッション模擬: get は保存領域から読み、変更はレスポンス完了時に永続化（astro のセッションと同じ方式） ----
export const sessionStore = new Map()
export function mkSession(sid) {
	let data = null
	const load = async () => { if (!data) { await sleep(LAT); data = new Map(sessionStore.get(sid) ?? []) } return data }
	const s = {
		regenerated: 0,
		async get(k) { return (await load()).get(k) },
		set(k, v) { (data ??= new Map(sessionStore.get(sid) ?? [])).set(k, v) },
		delete(k) { (data ??= new Map(sessionStore.get(sid) ?? [])).delete(k) },
		async regenerate() { s.regenerated++ },
		async persist() { if (data) sessionStore.set(sid, [...data]) },
	}
	return s
}

export const providerConfig = (extra = {}) => ({ guildId: GUILD, defaultRole: 10, adminIds: [], siteTitle: "Site", scopes: ["identify", "email", "guilds"], messages: {}, ...extra })
export const locals = (config = providerConfig()) => ({ emdash: { db: {}, config: { authProviders: [{ id: "discord", config }] } } })

/** state を保存したセッションを用意する */
export function seedState(sid, state = "st-" + sid, extra = {}) {
	sessionStore.set(sid, [["discord_oauth", { state, at: Date.now(), ...extra }]])
	return state
}

export function reset() {
	db.users = []; db.accounts = []; db.options = new Map()
	discord.users = {}; discord.faults = {}; discord.calls = []
	sessionStore.clear()
}

export const ENV = {
	DISCORD_CLIENT_ID: "cid",
	DISCORD_CLIENT_SECRET: "client-secret-value",
	DISCORD_BASE_URL: "https://discord.com",
	EMDASH_SITE_URL: "https://cms.example.test",
}
