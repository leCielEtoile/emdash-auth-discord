import { describe, it, expect, vi } from "vitest"
import { createHash } from "node:crypto"
import {
	DiscordAuthError, createState, buildAuthorizeUrl, isValidState, avatarUrl, mapProfile,
	parseIdList, decideRole, resolveAdminIds, isGuildMember, nextLoginData, exchangeCode, fetchMe, fetchAllGuilds,
	validateOptions, checkBaseUrl, createCodeVerifier, codeChallengeS256, messageFor, publicErrorCode, DEFAULT_MESSAGES, DISCORD_TIMEOUT_MS,
} from "../lib.js"

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

describe("createState", () => {
	it("48 桁の 16 進で、呼ぶたびに異なる", () => {
		const a = createState(), b = createState()
		expect(a).toMatch(/^[0-9a-f]{48}$/)
		expect(a).not.toBe(b)
	})
})

describe("buildAuthorizeUrl", () => {
	it("必要なパラメータをすべて含む", () => {
		const u = new URL(buildAuthorizeUrl({ baseUrl: "https://discord.com", clientId: "cid", redirectUri: "https://cms.test/cb", state: "st" }))
		expect(u.origin + u.pathname).toBe("https://discord.com/oauth2/authorize")
		expect(u.searchParams.get("client_id")).toBe("cid")
		expect(u.searchParams.get("redirect_uri")).toBe("https://cms.test/cb")
		expect(u.searchParams.get("response_type")).toBe("code")
		expect(u.searchParams.get("scope")).toBe("identify email guilds")
		expect(u.searchParams.get("state")).toBe("st")
	})
})

describe("PKCE（S256）", () => {
	it("code_verifier は 43 文字の base64url で、呼ぶたびに異なる", () => {
		const a = createCodeVerifier(), b = createCodeVerifier()
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(a).not.toBe(b)
	})
	it("code_challenge は base64url(SHA-256(verifier))", async () => {
		const v = createCodeVerifier()
		expect(await codeChallengeS256(v)).toBe(createHash("sha256").update(v).digest("base64url"))
		// RFC 7636 Appendix B のテストベクタ
		expect(await codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
	})
	it("buildAuthorizeUrl は codeChallenge があるときだけ code_challenge と method=S256 を付ける", () => {
		const base = { baseUrl: "https://discord.com", clientId: "c", redirectUri: "https://cms/cb", state: "s" }
		const withPkce = new URL(buildAuthorizeUrl({ ...base, codeChallenge: "ch" }))
		expect(withPkce.searchParams.get("code_challenge")).toBe("ch")
		expect(withPkce.searchParams.get("code_challenge_method")).toBe("S256")
		expect(new URL(buildAuthorizeUrl(base)).searchParams.has("code_challenge")).toBe(false)
	})
	it("exchangeCode は codeVerifier があるときだけ code_verifier を送る", async () => {
		const args = { baseUrl: "https://d.test", clientId: "c", clientSecret: "s", code: "x", redirectUri: "https://cms/cb" }
		const fetchFn = vi.fn(async () => json(200, { access_token: "tok" }))
		await exchangeCode({ ...args, fetchFn, codeVerifier: "ver" })
		await exchangeCode({ ...args, fetchFn })
		expect(new URLSearchParams(fetchFn.mock.calls[0][1].body).get("code_verifier")).toBe("ver")
		expect(new URLSearchParams(fetchFn.mock.calls[1][1].body).has("code_verifier")).toBe(false)
	})
})

describe("isValidState", () => {
	const saved = { state: "abc", at: 1_000_000 }
	it("一致かつ期限内なら true", () => expect(isValidState(saved, "abc", 1_000_000 + 1000)).toBe(true))
	it("不一致なら false", () => expect(isValidState(saved, "xyz", 1_000_000)).toBe(false))
	it("期限切れなら false", () => expect(isValidState(saved, "abc", 1_000_000 + 11 * 60 * 1000)).toBe(false))
	it("保存時刻（at）が無い・数値でないなら false", () => {
		expect(isValidState({ state: "abc" }, "abc", 1_000_000)).toBe(false)
		expect(isValidState({ state: "abc", at: "1000000" }, "abc", 1_000_000)).toBe(false)
	})
	it("期限ちょうど（10 分）は有効、1ms 超えたら無効", () => {
		expect(isValidState(saved, "abc", 1_000_000 + 10 * 60 * 1000)).toBe(true)
		expect(isValidState(saved, "abc", 1_000_000 + 10 * 60 * 1000 + 1)).toBe(false)
	})
	it("保存が無い・受信が空なら false", () => {
		expect(isValidState(undefined, "abc")).toBe(false)
		expect(isValidState(saved, "")).toBe(false)
		expect(isValidState(saved, null)).toBe(false)
	})
})

describe("avatarUrl / mapProfile", () => {
	it("アバターがあれば CDN の webp URL", () => {
		expect(avatarUrl({ id: "1", avatar: "h" })).toBe("https://cdn.discordapp.com/avatars/1/h.webp?size=256")
	})
	it("アバター未設定は null", () => expect(avatarUrl({ id: "1", avatar: null })).toBeNull())
	it("global_name（日本語・絵文字）を表示名にする", () => {
		const p = mapProfile({ id: "1", username: "u", global_name: "Alice🎸", avatar: null, email: "a@x.test", verified: true })
		expect(p).toEqual({ id: "1", email: "a@x.test", name: "Alice🎸", avatarUrl: null, emailVerified: true })
	})
	it("global_name が無ければ username", () => {
		expect(mapProfile({ id: "1", username: "user_c", global_name: null, email: "c@x.test", verified: true }).name).toBe("user_c")
	})
	it("verified が true でなければ email_not_verified で失敗する（未定義・文字列も拒否）", () => {
		for (const verified of [false, undefined, "true", 1]) {
			expect(() => mapProfile({ id: "1", username: "u", email: "d@x.test", verified })).toThrowError(expect.objectContaining({ code: "email_not_verified" }))
		}
	})
	it("email が無ければ email_required で失敗", () => {
		expect(() => mapProfile({ id: "1", username: "u", email: null, verified: true })).toThrowError(expect.objectContaining({ name: "DiscordAuthError", code: "email_required" }))
		expect(() => mapProfile({ id: "1", username: "u", verified: true })).toThrowError(expect.objectContaining({ code: "email_required" }))
	})
})

describe("parseIdList / decideRole", () => {
	it("空白・空要素・undefined を無視する", () => {
		expect([...parseIdList(" 1, 2 ,,3 ,")]).toEqual(["1", "2", "3"])
		expect(parseIdList("").size).toBe(0)
		expect(parseIdList(undefined).size).toBe(0)
	})
	it("管理者リストにあれば Admin(50)", () => {
		expect(decideRole({ discordId: "1", adminIds: new Set(["1"]) })).toBe(50)
	})
	it("管理者リストが空でも、初回 Admin を獲得していなければ Admin にしない（フェイルクローズ）", () => {
		expect(decideRole({ discordId: "9", adminIds: new Set() })).toBe(10)
		expect(decideRole({ discordId: "9", adminIds: new Set(), bootstrapAdmin: false, defaultRole: 40 })).toBe(40)
	})
	it("初回 Admin を獲得した（bootstrapAdmin）ときだけ Admin(50)", () => {
		expect(decideRole({ discordId: "9", adminIds: new Set(), bootstrapAdmin: true })).toBe(50)
	})
	it("それ以外は既定ロール（既定 Subscriber=10）", () => {
		expect(decideRole({ discordId: "9", adminIds: new Set(["1"]) })).toBe(10)
		expect(decideRole({ discordId: "9", adminIds: new Set(), defaultRole: 30 })).toBe(30)
	})
})

describe("resolveAdminIds（オプションと環境変数の和集合）", () => {
	const A = "200000000000000001", B = "200000000000000002", C = "200000000000000003"
	it("オプションと環境変数を合わせ、環境変数側は trim・空要素除去・重複除去する", () => {
		expect([...resolveAdminIds([A, B], ` ${B}, ${C} ,,`)].sort()).toEqual([A, B, C])
	})
	it("片方だけ・両方未設定でも動く", () => {
		expect([...resolveAdminIds([A], undefined)]).toEqual([A])
		expect([...resolveAdminIds(undefined, `${B},${C}`)].sort()).toEqual([B, C])
		expect(resolveAdminIds(undefined, undefined).size).toBe(0)
		expect(resolveAdminIds([], "").size).toBe(0)
	})
	it("数値・短すぎる ID・空白入り・配列以外は黙って捨てずに provider_not_configured で失敗する", () => {
		for (const bad of [[200000000000000001], ["123"], [` ${A}`], [A, null], A]) {
			expect(() => resolveAdminIds(bad, "")).toThrowError(expect.objectContaining({ code: "provider_not_configured" }))
		}
		expect(() => resolveAdminIds([], `${A},abc`)).toThrowError(expect.objectContaining({ code: "provider_not_configured" }))
	})
})

describe("validateOptions（discord() 呼び出し時の検証）", () => {
	const G = "100000000000000001", A = "200000000000000001"
	it("既定値: defaultRole=10、scopes は既定、guildId 未設定は undefined", () => {
		expect(validateOptions({})).toEqual({ guildId: undefined, defaultRole: 10, adminIds: [], scopes: ["identify", "email", "guilds"], bootstrapFirstAdmin: false, loginLabel: "Log in with Discord" })
		expect(validateOptions({ guildId: "" }).guildId).toBeUndefined()
	})
	it("正しい設定は通る", () => {
		for (const role of [10, 20, 30, 40]) expect(validateOptions({ guildId: G, defaultRole: role, adminIds: [A] }).defaultRole).toBe(role)
		expect(validateOptions({}, { DISCORD_ADMIN_IDS: ` ${A} ,` }).adminIds).toEqual([])
	})
	it.each([
		[{ defaultRole: 50 }, /defaultRole/],
		[{ defaultRole: "40" }, /defaultRole/],
		[{ defaultRole: 999 }, /defaultRole/],
		[{ guildId: 100000000000000001 }, /guildId.*number/],
		[{ guildId: "1234" }, /guildId/],
		[{ guildId: "abcdefghijklmnopqr" }, /guildId/],
		[{ adminIds: [200000000000000001] }, /adminIds/],
		[{ adminIds: ["1"] }, /adminIds/],
		[{ adminIds: A }, /adminIds/],
		[{ scopes: ["identify", "email"] }, /scopes/],
		[{ bootstrapFirstAdmin: "true" }, /bootstrapFirstAdmin/],
	])("不正な設定 %j は分かるエラーで失敗する", (opts, re) => {
		expect(() => validateOptions(opts)).toThrowError(re)
	})
	it("環境変数 DISCORD_ADMIN_IDS の不正な ID でも失敗する", () => {
		expect(() => validateOptions({}, { DISCORD_ADMIN_IDS: `${A},12345` })).toThrowError(/DISCORD_ADMIN_IDS/)
	})
	it("ID は 17〜20 桁の境界を守る", () => {
		expect(() => validateOptions({ guildId: "1".repeat(17) })).not.toThrow()
		expect(() => validateOptions({ guildId: "1".repeat(20) })).not.toThrow()
		expect(() => validateOptions({ guildId: "1".repeat(16) })).toThrow()
		expect(() => validateOptions({ guildId: "1".repeat(21) })).toThrow()
	})
})

describe("isGuildMember", () => {
	it("対象ギルドを含めば true", () => expect(isGuildMember([{ id: "1" }, { id: "2" }], "2")).toBe(true))
	it("含まなければ false", () => expect(isGuildMember([{ id: "1" }], "2")).toBe(false))
	it("guildId 未設定・配列でない場合は false（フェイルクローズ）", () => {
		expect(isGuildMember([{ id: "1" }], undefined)).toBe(false)
		expect(isGuildMember([{ id: "1" }], "")).toBe(false)
		expect(isGuildMember(null, "1")).toBe(false)
		// id を持たない要素があっても、guildId 未設定なら一致扱いにしない
		expect(isGuildMember([{}], undefined)).toBe(false)
	})
})

describe("nextLoginData", () => {
	const me = { id: "1", username: "u", locale: "ja" }
	it("初回は loginCount=1 で first/last が同じ", () => {
		const d = nextLoginData(null, me, "2026-10-03T00:00:00.000Z")
		expect(d.discord).toEqual({ id: "1", username: "u", locale: "ja", firstLoginAt: "2026-10-03T00:00:00.000Z", lastLoginAt: "2026-10-03T00:00:00.000Z", loginCount: 1 })
	})
	it("2 回目以降は loginCount が増え、firstLoginAt は保持、他のキーも保持", () => {
		const prev = { other: 1, discord: { firstLoginAt: "2026-01-01T00:00:00.000Z", loginCount: 4 } }
		const d = nextLoginData(prev, me, "2026-10-03T00:00:00.000Z")
		expect(d.other).toBe(1)
		expect(d.discord.loginCount).toBe(5)
		expect(d.discord.firstLoginAt).toBe("2026-01-01T00:00:00.000Z")
		expect(d.discord.lastLoginAt).toBe("2026-10-03T00:00:00.000Z")
	})
	it("locale が無ければ null", () => expect(nextLoginData({}, { id: "1", username: "u" }, "t").discord.locale).toBeNull())
})

describe("exchangeCode", () => {
	const args = { baseUrl: "https://d.test", clientId: "c", clientSecret: "s", code: "code", redirectUri: "https://cms/cb" }
	it("アクセストークンを返し、正しいボディで POST する", async () => {
		const fetchFn = vi.fn(async () => json(200, { access_token: "tok" }))
		expect(await exchangeCode({ ...args, fetchFn })).toBe("tok")
		const [url, init] = fetchFn.mock.calls[0]
		expect(url).toBe("https://d.test/api/oauth2/token")
		expect(init.method).toBe("POST")
		const body = new URLSearchParams(init.body)
		expect(body.get("grant_type")).toBe("authorization_code")
		expect(body.get("code")).toBe("code")
		expect(body.get("client_secret")).toBe("s")
		expect(body.get("client_id")).toBe("c")
		expect(body.get("redirect_uri")).toBe("https://cms/cb")
		expect(init.signal).toBeInstanceOf(AbortSignal)
	})
	it("HTTP エラー・トークン欠落は token_exchange_failed", async () => {
		await expect(exchangeCode({ ...args, fetchFn: async () => json(400, {}) })).rejects.toMatchObject({ code: "token_exchange_failed" })
		await expect(exchangeCode({ ...args, fetchFn: async () => json(200, {}) })).rejects.toMatchObject({ code: "token_exchange_failed" })
	})
})

describe("fetchMe", () => {
	it("プロフィールを返す", async () => {
		const fetchFn = vi.fn(async () => json(200, { id: "1" }))
		expect(await fetchMe({ baseUrl: "https://d.test", accessToken: "t", fetchFn })).toEqual({ id: "1" })
		expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe("Bearer t")
	})
	it("失敗は profile_fetch_failed", async () => {
		await expect(fetchMe({ baseUrl: "https://d.test", accessToken: "t", fetchFn: async () => json(401, {}) })).rejects.toMatchObject({ code: "profile_fetch_failed" })
	})
})

describe("fetchAllGuilds（200 件超のページング）", () => {
	const page = (from, n) => Array.from({ length: n }, (_, i) => ({ id: String(from + i) }))
	it("200 件未満なら 1 回で終わる", async () => {
		const fetchFn = vi.fn(async () => json(200, page(1, 3)))
		expect((await fetchAllGuilds({ baseUrl: "https://d.test", accessToken: "t", fetchFn })).length).toBe(3)
		expect(fetchFn).toHaveBeenCalledTimes(1)
		expect(fetchFn.mock.calls[0][0]).toContain("limit=200")
	})
	it("ちょうど 200 件なら after=最後の ID で次ページを取り、2 ページ目の対象ギルドも見つかる", async () => {
		const calls = []
		const fetchFn = vi.fn(async (url) => {
			calls.push(url)
			return url.includes("after=200") ? json(200, [{ id: "TARGET" }]) : json(200, page(1, 200))
		})
		const all = await fetchAllGuilds({ baseUrl: "https://d.test", accessToken: "t", fetchFn })
		expect(all.length).toBe(201)
		expect(isGuildMember(all, "TARGET")).toBe(true)
		expect(calls[1]).toContain("after=200")
	})
	it("HTTP エラー・配列でない応答は guild_fetch_failed", async () => {
		await expect(fetchAllGuilds({ baseUrl: "https://d.test", accessToken: "t", fetchFn: async () => json(500, {}) })).rejects.toMatchObject({ code: "guild_fetch_failed", details: { status: 500 } })
		await expect(fetchAllGuilds({ baseUrl: "https://d.test", accessToken: "t", fetchFn: async () => json(200, {}) })).rejects.toMatchObject({ code: "guild_fetch_failed" })
	})
	it("10 ページ（2000 件）読んでも続きがあれば、黙って打ち切らずに guild_fetch_failed（フェイルクローズ）", async () => {
		const fetchFn = vi.fn(async () => json(200, page(1, 200)))
		await expect(fetchAllGuilds({ baseUrl: "https://d.test", accessToken: "t", fetchFn })).rejects.toMatchObject({ code: "guild_fetch_failed" })
		expect(fetchFn).toHaveBeenCalledTimes(10)
	})
})

describe("Discord API 呼び出しの共通処理（タイムアウト・429・通信失敗）", () => {
	const base = { baseUrl: "https://d.test", accessToken: "t" }
	const calls = [
		["exchangeCode", (o) => exchangeCode({ baseUrl: "https://d.test", clientId: "c", clientSecret: "s", code: "x", redirectUri: "https://cms/cb", ...o }), "token_exchange_failed"],
		["fetchMe", (o) => fetchMe({ ...base, ...o }), "profile_fetch_failed"],
		["fetchAllGuilds", (o) => fetchAllGuilds({ ...base, ...o }), "guild_fetch_failed"],
	]
	it("既定のタイムアウトは 10 秒", () => expect(DISCORD_TIMEOUT_MS).toBe(10_000))
	it.each(calls)("%s: 応答が無ければタイムアウトして discord_timeout（signal を fetch に渡している）", async (_n, call) => {
		// signal を無視する fetch だと 300ms 後に成功してしまうので、渡し忘れると失敗する
		const fetchFn = (url, init) => new Promise((resolve, reject) => {
			const t = setTimeout(() => resolve(json(200, [])), 300)
			init.signal?.addEventListener("abort", () => { clearTimeout(t); reject(init.signal.reason) })
		})
		await expect(call({ fetchFn, timeoutMs: 20 })).rejects.toMatchObject({ code: "discord_timeout", details: { timeoutMs: 20 } })
	})
	it.each(calls)("%s: 429 は rate_limited になり Retry-After を details に持つ", async (_n, call) => {
		const fetchFn = async () => ({ ok: false, status: 429, headers: new Headers({ "Retry-After": "7" }), json: async () => ({}) })
		await expect(call({ fetchFn })).rejects.toMatchObject({ code: "rate_limited", details: { status: 429, retryAfter: "7" } })
	})
	it.each(calls)("%s: 通信失敗はエンドポイント別の *_failed（例外名だけを残し、本文は残さない）", async (_n, call, failCode) => {
		const fetchFn = async () => { throw new TypeError("connect ECONNREFUSED secret-detail") }
		const err = await call({ fetchFn }).catch((e) => e)
		expect(err).toMatchObject({ code: failCode, details: { error: "TypeError" } })
		expect(JSON.stringify(err.details) + err.message).not.toContain("secret-detail")
	})
	it.each(calls)("%s: JSON として読めない応答は *_failed", async (_n, call, failCode) => {
		const fetchFn = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad") } })
		await expect(call({ fetchFn })).rejects.toMatchObject({ code: failCode })
	})
})

describe("messageFor / publicErrorCode（画面に出す固定文言）", () => {
	it("既定は英語の固定文言", () => {
		expect(messageFor("not_guild_member")).toBe("Only members of this Discord server can log in.")
		expect(messageFor("rate_limited")).toMatch(/wait/)
	})
	it("options.messages の対応キーで上書きできる（空文字は既定にフォールバック）", () => {
		expect(messageFor("not_guild_member", { notGuildMember: "メンバー限定です" })).toBe("メンバー限定です")
		expect(messageFor("invalid_state", { invalidState: "" })).toBe(DEFAULT_MESSAGES.invalidState)
	})
	it("未知のコードは oauth_error とその文言にまとめる", () => {
		expect(publicErrorCode("user_not_found")).toBe("user_not_found")
		expect(publicErrorCode("something_internal")).toBe("oauth_error")
		expect(publicErrorCode(undefined)).toBe("oauth_error")
		expect(messageFor("something_internal")).toBe(DEFAULT_MESSAGES.oauthError)
	})
	it("validateOptions は messages の未知キー・文字列以外を拒否する", () => {
		expect(() => validateOptions({ messages: { notGuildMembr: "x" } })).toThrowError(/notGuildMembr/)
		expect(() => validateOptions({ messages: { notGuildMember: 1 } })).toThrowError(/notGuildMember/)
		expect(() => validateOptions({ messages: "x" })).toThrowError(/messages/)
		expect(() => validateOptions({ messages: { notGuildMember: "ok" } })).not.toThrow()
	})
})

describe("checkBaseUrl（DISCORD_BASE_URL の検証）", () => {
	const bad = (raw, prod) => expect(() => checkBaseUrl(raw, prod)).toThrowError(expect.objectContaining({ code: "provider_not_configured" }))
	it("未設定なら https://discord.com", () => {
		expect(checkBaseUrl(undefined)).toBe("https://discord.com")
		expect(checkBaseUrl("", true)).toBe("https://discord.com")
	})
	it("production 以外: https と localhost / 127.0.0.1 の http だけを許可し、末尾の / は除く", () => {
		expect(checkBaseUrl("https://discord.test/")).toBe("https://discord.test")
		expect(checkBaseUrl("http://localhost:4400")).toBe("http://localhost:4400")
		expect(checkBaseUrl("http://127.0.0.1:4400/")).toBe("http://127.0.0.1:4400")
		for (const raw of ["http://discord.test", "http://localhost.evil.test", "http://10.0.0.1:4400", "ftp://localhost", "not a url"]) bad(raw, false)
	})
	it("production では https://discord.com 以外はすべて拒否（警告ではなくエラー）", () => {
		expect(checkBaseUrl("https://discord.com/", true)).toBe("https://discord.com")
		for (const raw of ["http://localhost:4400", "http://127.0.0.1:4400", "https://discord.test", "https://discord.com.evil.test"]) bad(raw, true)
	})
})
