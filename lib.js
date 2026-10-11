/** Discord OAuth の純粋ロジック（ネットワークは fetchFn 注入で、DB・フレームワークには触れない） */

export class DiscordAuthError extends Error {
	/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] サーバーログ用の補足（秘密情報は入れない） */
	constructor(code, message, details = {}) {
		super(message)
		this.name = "DiscordAuthError"
		this.code = code
		this.details = details
	}
}

export const DEFAULT_SCOPES = ["identify", "email", "guilds"]
/** 新規ユーザーの既定ロール（10 = Subscriber。最小権限） */
export const DEFAULT_ROLE = 10
/** defaultRole に指定できる値。50（Admin）は adminIds でのみ付与する */
export const ALLOWED_DEFAULT_ROLES = [10, 20, 30, 40]
export const ADMIN_ROLE = 50
/** Discord の ID（スノーフレーク）。Number では精度が落ちるため文字列で扱う */
export const SNOWFLAKE = /^\d{17,20}$/
/** Discord API 1 回あたりのタイムアウト */
export const DISCORD_TIMEOUT_MS = 10_000
/** ログインボタンの既定の文言（loginLabel で上書きできる） */
export const DEFAULT_LOGIN_LABEL = "Log in with Discord"

/**
 * ログイン画面に出す文言の既定（英語）。キーはエラーコードの camelCase。
 * options.messages で個別に上書きできる。Discord からの error_description や内部エラーの文言は画面に出さない。
 */
export const DEFAULT_MESSAGES = {
	providerNotConfigured: "Discord login is not configured. Please contact the site administrator.",
	serverError: "Login is temporarily unavailable. Please try again later.",
	invalidCallback: "The login response from Discord was incomplete. Please try again.",
	invalidState: "Your login session expired or is invalid. Please try again.",
	oauthDenied: "Discord login was cancelled.",
	notGuildMember: "Only members of this Discord server can log in.",
	emailRequired: "Your Discord account has no email address. Add one in Discord and try again.",
	emailNotVerified: "Your Discord email address is not verified. Verify it in Discord and try again.",
	signupNotAllowed: "Sign-up is not allowed for this account.",
	accountDisabled: "This account has been disabled.",
	userNotFound: "Your account was not found. It may have been deleted.",
	rateLimited: "Discord is limiting requests right now. Please wait a moment and try again.",
	discordTimeout: "Discord did not respond in time. Please try again.",
	tokenExchangeFailed: "Could not complete login with Discord. Please try again.",
	profileFetchFailed: "Could not complete login with Discord. Please try again.",
	guildFetchFailed: "Could not complete login with Discord. Please try again.",
	oauthError: "Login failed. Please try again.",
}
const messageKey = (code) => code.replace(/_([a-z])/g, (_, c) => c.toUpperCase())

/** 既知のエラーコードはそのまま、未知のコード（ライブラリ内部のコード等）は oauth_error にまとめる */
export const publicErrorCode = (code) => (typeof code === "string" && Object.hasOwn(DEFAULT_MESSAGES, messageKey(code)) ? code : "oauth_error")

/** エラーコードに対応する固定文言（options.messages の上書きを優先） */
export function messageFor(code, overrides = {}) {
	const key = messageKey(publicErrorCode(code))
	const custom = overrides?.[key]
	return typeof custom === "string" && custom !== "" ? custom : DEFAULT_MESSAGES[key]
}

const STATE_TTL_MS = 10 * 60 * 1000
const GUILDS_PAGE_SIZE = 200
const GUILDS_MAX_PAGES = 10

export function createState(getRandomValues = (a) => crypto.getRandomValues(a)) {
	const bytes = getRandomValues(new Uint8Array(24))
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** PKCE の code_verifier（32 バイトの乱数を base64url にした 43 文字） */
export function createCodeVerifier(getRandomValues = (a) => crypto.getRandomValues(a)) {
	return base64url(getRandomValues(new Uint8Array(32)))
}

/** PKCE の code_challenge（S256 = base64url(SHA-256(verifier))） */
export async function codeChallengeS256(verifier) {
	return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
}

export function buildAuthorizeUrl({ baseUrl, clientId, redirectUri, scopes = DEFAULT_SCOPES, state, codeChallenge }) {
	const url = new URL(`${baseUrl}/oauth2/authorize`)
	url.searchParams.set("client_id", clientId)
	url.searchParams.set("redirect_uri", redirectUri)
	url.searchParams.set("response_type", "code")
	url.searchParams.set("scope", scopes.join(" "))
	url.searchParams.set("state", state)
	if (codeChallenge) {
		url.searchParams.set("code_challenge", codeChallenge)
		url.searchParams.set("code_challenge_method", "S256")
	}
	return url.toString()
}

export function isValidState(saved, received, now = Date.now(), ttlMs = STATE_TTL_MS) {
	if (!saved || typeof saved.state !== "string" || typeof saved.at !== "number" || !received) return false
	if (saved.state !== received) return false
	return now - saved.at <= ttlMs
}

export function avatarUrl(user) {
	return user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=256` : null
}

export function mapProfile(me) {
	if (!me.email) throw new DiscordAuthError("email_required", "Discord profile has no email")
	// 多層防御: @emdash-cms/auth の requireVerifiedEmail に頼らず、ここでも未検証メールを拒否する
	if (me.verified !== true) throw new DiscordAuthError("email_not_verified", "Discord email is not verified")
	return {
		id: me.id,
		email: me.email,
		name: me.global_name || me.username,
		avatarUrl: avatarUrl(me),
		emailVerified: true,
	}
}

export function parseIdList(csv) {
	return new Set((csv ?? "").split(",").map((s) => s.trim()).filter(Boolean))
}

/** スノーフレーク形式でない要素（文字列以外を含む）を返す */
export function invalidIds(ids) {
	return ids.filter((v) => typeof v !== "string" || !SNOWFLAKE.test(v))
}

/**
 * オプション（string[]）と環境変数（カンマ区切り）の和集合。
 * 不正な ID は黙って捨てずに失敗させる（管理者の指定漏れに気付けないため）。
 */
export function resolveAdminIds(optionIds, envCsv) {
	const fromOption = optionIds ?? []
	const fromEnv = [...parseIdList(envCsv)]
	if (!Array.isArray(fromOption) || invalidIds([...fromOption, ...fromEnv]).length > 0) {
		throw new DiscordAuthError("provider_not_configured", "adminIds / DISCORD_ADMIN_IDS contains an invalid Discord user ID", { setting: "adminIds" })
	}
	return new Set([...fromOption, ...fromEnv])
}

/** 管理者 ID に載っているか、初回 Admin を獲得した（bootstrapAdmin）なら Admin、それ以外は既定ロール */
export function decideRole({ discordId, adminIds, bootstrapAdmin = false, defaultRole = DEFAULT_ROLE }) {
	if (adminIds.has(discordId)) return ADMIN_ROLE
	if (bootstrapAdmin === true) return ADMIN_ROLE
	return defaultRole
}

export const DISCORD_ORIGIN = "https://discord.com"
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"])

/**
 * DISCORD_BASE_URL（テスト用モックの向き先）の検証。クライアントシークレットの送信先になるため厳しく制限する。
 * - 未設定なら https://discord.com
 * - production では https://discord.com 以外を拒否
 * - それ以外では https、または localhost / 127.0.0.1 の http のみ許可
 */
export function checkBaseUrl(raw, production = false) {
	if (!raw) return DISCORD_ORIGIN
	const reject = (why) => { throw new DiscordAuthError("provider_not_configured", `DISCORD_BASE_URL ${why}`, { setting: "DISCORD_BASE_URL" }) }
	let u
	try { u = new URL(raw) } catch { reject("is not a valid URL") }
	const normalized = (u.origin + u.pathname).replace(/\/$/, "")
	if (production) {
		if (normalized !== DISCORD_ORIGIN) reject(`must be ${DISCORD_ORIGIN} (or unset) when NODE_ENV=production`)
		return normalized
	}
	if (u.protocol === "https:") return normalized
	if (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname)) return normalized
	reject("must use https, or http only for localhost / 127.0.0.1")
}

/**
 * discord() に渡されたオプションを検証し、正規化した設定を返す。違反があれば起動時に分かるよう例外を投げる。
 * env は呼び出し時点の環境変数（DISCORD_ADMIN_IDS を検証する）。
 */
export function validateOptions(options = {}, env = {}) {
	const errors = []
	const { guildId, defaultRole = DEFAULT_ROLE, adminIds = [], scopes = DEFAULT_SCOPES, bootstrapFirstAdmin = false } = options
	if (typeof bootstrapFirstAdmin !== "boolean") errors.push("bootstrapFirstAdmin must be true or false")
	if (guildId !== undefined && guildId !== "" && (typeof guildId !== "string" || !SNOWFLAKE.test(guildId))) {
		errors.push(`guildId must be a Discord server ID string of 17-20 digits (got ${typeof guildId === "number" ? "a number; quote it as a string" : JSON.stringify(guildId)})`)
	}
	if (!ALLOWED_DEFAULT_ROLES.includes(defaultRole)) {
		errors.push(`defaultRole must be one of ${ALLOWED_DEFAULT_ROLES.join(", ")} (got ${JSON.stringify(defaultRole)}). Admin (50) can only be granted through adminIds`)
	}
	if (!Array.isArray(adminIds)) errors.push("adminIds must be an array of Discord user ID strings")
	else if (invalidIds(adminIds).length > 0) errors.push(`adminIds must contain only Discord user ID strings of 17-20 digits (invalid: ${invalidIds(adminIds).map((v) => JSON.stringify(v)).join(", ")})`)
	const envBad = invalidIds([...parseIdList(env.DISCORD_ADMIN_IDS)])
	if (envBad.length > 0) errors.push(`DISCORD_ADMIN_IDS must be comma-separated Discord user IDs of 17-20 digits (invalid: ${envBad.map((v) => JSON.stringify(v)).join(", ")})`)
	if (!Array.isArray(scopes) || DEFAULT_SCOPES.some((s) => !scopes.includes(s))) {
		errors.push(`scopes must include ${DEFAULT_SCOPES.map((s) => `"${s}"`).join(", ")}`)
	}
	const { messages = {}, loginLabel } = options
	if (loginLabel !== undefined && (typeof loginLabel !== "string" || loginLabel.trim() === "")) errors.push("loginLabel must be a non-empty string")
	if (typeof messages !== "object" || messages === null || Array.isArray(messages)) errors.push("messages must be an object")
	else {
		for (const [k, v] of Object.entries(messages)) {
			if (!Object.hasOwn(DEFAULT_MESSAGES, k)) errors.push(`messages.${k} is not a known message key (known: ${Object.keys(DEFAULT_MESSAGES).join(", ")})`)
			else if (typeof v !== "string") errors.push(`messages.${k} must be a string`)
		}
	}
	if (errors.length > 0) throw new Error(`[emdash-auth-discord] invalid options:\n- ${errors.join("\n- ")}`)
	return { guildId: guildId || undefined, defaultRole, adminIds, scopes, bootstrapFirstAdmin, loginLabel: loginLabel ?? DEFAULT_LOGIN_LABEL }
}

export function isGuildMember(guilds, guildId) {
	if (!guildId || !Array.isArray(guilds)) return false
	return guilds.some((g) => g.id === guildId)
}

export function nextLoginData(prev, me, nowIso) {
	const base = prev && typeof prev === "object" ? prev : {}
	const d = base.discord ?? {}
	return {
		...base,
		discord: {
			id: me.id,
			username: me.username,
			locale: me.locale ?? null,
			firstLoginAt: d.firstLoginAt ?? nowIso,
			lastLoginAt: nowIso,
			loginCount: (d.loginCount ?? 0) + 1,
		},
	}
}

/**
 * Discord API の呼び出し。タイムアウト（既定 10 秒）・429・HTTP エラー・通信失敗を DiscordAuthError にする。
 * メッセージと details にはトークンや URL のクエリを入れない（サーバーログにそのまま出すため）。
 */
async function discordFetch(fetchFn, url, init, { failCode, endpoint, timeoutMs = DISCORD_TIMEOUT_MS }) {
	let res
	try {
		res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
	} catch (e) {
		const name = e instanceof Error ? e.name : "Error"
		if (name === "TimeoutError" || name === "AbortError") {
			throw new DiscordAuthError("discord_timeout", `${endpoint} timed out`, { endpoint, timeoutMs })
		}
		throw new DiscordAuthError(failCode, `${endpoint} request failed`, { endpoint, error: name })
	}
	if (res.status === 429) {
		throw new DiscordAuthError("rate_limited", `${endpoint} was rate limited`, { endpoint, status: 429, retryAfter: res.headers?.get?.("retry-after") ?? null })
	}
	if (!res.ok) throw new DiscordAuthError(failCode, `${endpoint} returned ${res.status}`, { endpoint, status: res.status })
	try {
		return await res.json()
	} catch {
		throw new DiscordAuthError(failCode, `${endpoint} returned invalid JSON`, { endpoint, status: res.status })
	}
}

export async function exchangeCode({ fetchFn = fetch, baseUrl, clientId, clientSecret, code, redirectUri, codeVerifier, timeoutMs }) {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		client_id: clientId,
		client_secret: clientSecret,
	})
	// PKCE（login で code_challenge を送った場合のみ。更新前に始まったログインは verifier を持たないので送らない）
	if (codeVerifier) body.set("code_verifier", codeVerifier)
	const json = await discordFetch(fetchFn, `${baseUrl}/api/oauth2/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body,
	}, { failCode: "token_exchange_failed", endpoint: "token", timeoutMs })
	if (!json?.access_token) throw new DiscordAuthError("token_exchange_failed", "no access_token in response", { endpoint: "token" })
	return json.access_token
}

const authHeaders = (accessToken) => ({ Authorization: `Bearer ${accessToken}`, Accept: "application/json" })

export async function fetchMe({ fetchFn = fetch, baseUrl, accessToken, timeoutMs }) {
	return discordFetch(fetchFn, `${baseUrl}/api/users/@me`, { headers: authHeaders(accessToken) }, { failCode: "profile_fetch_failed", endpoint: "users/@me", timeoutMs })
}

export async function fetchAllGuilds({ fetchFn = fetch, baseUrl, accessToken, timeoutMs }) {
	const all = []
	let after
	for (let i = 0; i < GUILDS_MAX_PAGES; i++) {
		const qs = `limit=${GUILDS_PAGE_SIZE}${after ? `&after=${after}` : ""}`
		const page = await discordFetch(fetchFn, `${baseUrl}/api/users/@me/guilds?${qs}`, { headers: authHeaders(accessToken) }, { failCode: "guild_fetch_failed", endpoint: "users/@me/guilds", timeoutMs })
		if (!Array.isArray(page)) throw new DiscordAuthError("guild_fetch_failed", "guilds response is not an array", { endpoint: "users/@me/guilds" })
		all.push(...page)
		if (page.length < GUILDS_PAGE_SIZE) return all
		after = page[page.length - 1].id
	}
	// 上限まで読んでも続きがある場合は確認しきれないので、黙って打ち切らずに失敗させる（フェイルクローズ）
	throw new DiscordAuthError("guild_fetch_failed", `more than ${GUILDS_PAGE_SIZE * GUILDS_MAX_PAGES} guilds`, { endpoint: "users/@me/guilds" })
}
