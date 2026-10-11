import { OptionsRepository } from "emdash"
import { OAuthError, Role, findOrCreateOAuthUser } from "@emdash-cms/auth"
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely"
import {
	DiscordAuthError, decideRole, exchangeCode, fetchAllGuilds, fetchMe, isGuildMember,
	isValidState, mapProfile, nextLoginData, resolveAdminIds,
} from "../lib.js"
import { discordBaseUrl, fail, getConfig, getEnv, publicOrigin } from "../shared.js"

export const prerender = false

const isBootstrapEnabled = async (cfg) => cfg.bootstrapFirstAdmin === true || (await getEnv("DISCORD_BOOTSTRAP_FIRST_ADMIN")) === "1"

/** bootstrapFirstAdmin で Admin を獲得した Discord ID を記録するオプション名（一度だけ付与するための印） */
export const BOOTSTRAP_KEY = "emdash-auth-discord:bootstrap_admin"

const isSetupComplete = async (options) => {
	const done = await options.get("emdash:setup_complete")
	return done === true || done === "true"
}

async function ensureSetupComplete(options, siteTitle) {
	if (await isSetupComplete(options)) return
	if (!(await options.get("emdash:site_title"))) await options.set("emdash:site_title", siteTitle)
	await options.set("emdash:setup_complete", true)
}

/**
 * 初回 Admin の獲得（bootstrapFirstAdmin 有効かつ初期セットアップ未完了のときだけ呼ぶ）。
 * INSERT ... ON CONFLICT DO NOTHING（setIfAbsent）で原子的に 1 人だけが獲得できる。
 * 獲得済みの本人が再試行した場合（ユーザー作成前に失敗した等）は引き続き本人を Admin とする。
 */
async function claimBootstrapAdmin(options, discordId) {
	if (await options.setIfAbsent(BOOTSTRAP_KEY, discordId)) return true
	return (await options.get(BOOTSTRAP_KEY)) === discordId
}

/** Discord ID でリンク済みのユーザー、またはメールが一致する既存ユーザーが無効化されていれば返す */
async function findDisabledUser(adapter, discordId, email) {
	const account = await adapter.getOAuthAccount("discord", discordId)
	const user = account ? await adapter.getUserById(account.userId) : await adapter.getUserByEmail(email)
	return user?.disabled ? user : null
}

/** Discord から返る error パラメータはログ用に形式を確認してから残す（任意の文字列をログへ流さない） */
const safeOAuthError = (v) => (/^[a-z_]{1,64}$/.test(v) ? v : "invalid")

export const GET = async ({ request, session, redirect, locals }) => {
	const { emdash } = locals
	const cfg = getConfig(locals)
	const messages = cfg.messages
	const url = new URL(request.url)
	// error_description は表示も記録もしない（任意の文言をログイン画面に出させない）
	if (url.searchParams.get("error")) {
		return fail(redirect, "oauth_denied", { messages, log: { error: safeOAuthError(url.searchParams.get("error")) } })
	}
	const code = url.searchParams.get("code")
	const state = url.searchParams.get("state")
	if (!code || !state) return fail(redirect, "invalid_callback", { messages, log: { hasCode: Boolean(code), hasState: Boolean(state) } })
	if (!emdash?.db || !session) return fail(redirect, "server_error", { messages, log: { reason: !session ? "session unavailable" : "database unavailable" } })

	// state は読み出した直後に破棄し（get → delete）、以降の失敗でも再利用できないようにする（CSRF・再送対策）。
	// ただしセッションの変更はレスポンス完了時に保存されるため、同じ Cookie の並行リクエストまでは防げない（README 参照）
	const saved = await session.get("discord_oauth")
	session.delete("discord_oauth")
	if (!isValidState(saved, state)) return fail(redirect, "invalid_state", { messages })

	const clientId = await getEnv("DISCORD_CLIENT_ID")
	const clientSecret = await getEnv("DISCORD_CLIENT_SECRET")
	const missing = [!clientId && "DISCORD_CLIENT_ID", !clientSecret && "DISCORD_CLIENT_SECRET", !cfg.guildId && "guildId"].filter(Boolean)
	if (missing.length > 0) return fail(redirect, "provider_not_configured", { messages, log: { missing } })

	try {
		const baseUrl = await discordBaseUrl()
		const origin = await publicOrigin(request, locals)
		const accessToken = await exchangeCode({
			baseUrl,
			clientId,
			clientSecret,
			code,
			redirectUri: `${origin}/_emdash/api/auth/discord/callback`,
			codeVerifier: typeof saved.verifier === "string" ? saved.verifier : undefined,
		})
		const [me, guilds] = await Promise.all([
			fetchMe({ baseUrl, accessToken }),
			fetchAllGuilds({ baseUrl, accessToken }),
		])
		if (!isGuildMember(guilds, cfg.guildId)) return fail(redirect, "not_guild_member", { messages })
		const profile = mapProfile(me)

		const adapter = createKyselyAdapter(emdash.db)
		const options = new OptionsRepository(emdash.db)
		// 無効化済みユーザーは、メール一致による自動リンク（OAuth アカウント行の作成）より前に拒否する
		if (await findDisabledUser(adapter, me.id, profile.email)) return fail(redirect, "account_disabled", { messages })
		const adminIds = resolveAdminIds(cfg.adminIds, await getEnv("DISCORD_ADMIN_IDS"))
		// 管理者 ID が無い場合に Admin を自動付与するのは、明示的にオプトインし、かつ初期セットアップ前のときだけ（フェイルクローズ）
		let bootstrapAdmin = false
		if (!adminIds.has(me.id) && (await isBootstrapEnabled(cfg)) && !(await isSetupComplete(options))) {
			bootstrapAdmin = await claimBootstrapAdmin(options, me.id)
			if (bootstrapAdmin) console.warn("[discord-auth] bootstrapFirstAdmin: granted Admin to the first Discord login before setup was complete. Configure adminIds and turn bootstrapFirstAdmin off.")
		}
		const role = decideRole({ discordId: me.id, adminIds, bootstrapAdmin, defaultRole: cfg.defaultRole })

		let user = await findOrCreateOAuthUser(adapter, "discord", profile, async () => ({ allowed: true, role }), { requireVerifiedEmail: true })
		if (user.disabled) return fail(redirect, "account_disabled", { messages })

		// 管理者リストに載った（または初回 Admin を獲得した）既存ユーザーは昇格する（自動降格はしない）
		if (role === Role.ADMIN && user.role < Role.ADMIN) {
			await adapter.updateUser(user.id, { role: Role.ADMIN })
			user = { ...user, role: Role.ADMIN }
		}
		if (user.role === Role.ADMIN) await ensureSetupComplete(options, cfg.siteTitle ?? "EmDash")

		// ログインのたびに表示名・アバターを同期し、利用実績を記録する
		await adapter.updateUser(user.id, {
			name: profile.name,
			avatarUrl: profile.avatarUrl,
			data: nextLoginData(user.data, me, new Date().toISOString()),
		})

		// セッション固定化対策: ログイン成功時に ID を再生成する
		await session.regenerate()
		session.set("user", { id: user.id })
		return redirect("/_emdash/admin")
	} catch (e) {
		// サーバーログにはコードと補足（HTTP ステータス・Retry-After 等）だけを残し、画面にはコードごとの固定文言を出す
		if (e instanceof DiscordAuthError) {
			if (e.code === "rate_limited") console.warn("[discord-auth] Discord rate limit hit; Retry-After:", e.details?.retryAfter ?? "unknown")
			return fail(redirect, e.code, { messages, log: e.details })
		}
		if (e instanceof OAuthError) return fail(redirect, e.code, { messages, log: { source: "@emdash-cms/auth" } })
		console.error("[discord-auth] callback error:", e instanceof Error ? `${e.name}: ${e.message}` : e)
		return fail(redirect, "oauth_error", { messages })
	}
}
