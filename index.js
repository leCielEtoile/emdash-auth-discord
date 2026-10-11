import { fileURLToPath } from "node:url"
import { checkBaseUrl, validateOptions } from "./lib.js"

const p = (rel) => fileURLToPath(new URL(rel, import.meta.url))

/**
 * EmDash 用 Discord 認証プロバイダ。
 * @param {{
 *   guildId?: string,
 *   defaultRole?: 10|20|30|40,
 *   scopes?: string[],
 *   adminIds?: string[],
 *   bootstrapFirstAdmin?: boolean,
 *   siteTitle?: string,
 *   loginLabel?: string,
 *   messages?: Record<string, string>,
 * }} [options]
 *   guildId 未設定の場合、ログインは拒否される（フェイルクローズ）
 *   guildId / adminIds は 17〜20 桁の数字の文字列。defaultRole は 10/20/30/40（既定 10）。違反は呼び出し時に例外
 *   adminIds は環境変数 DISCORD_ADMIN_IDS（カンマ区切り）との和集合で使われる
 *   bootstrapFirstAdmin（既定 false。環境変数 DISCORD_BOOTSTRAP_FIRST_ADMIN=1 でも有効）は、
 *   EmDash の初期セットアップ完了前に限り、最初にログインした 1 人だけを Admin にする
 */
export function discord(options = {}) {
	const env = typeof process !== "undefined" ? process.env : {}
	const { guildId, defaultRole, adminIds, scopes, bootstrapFirstAdmin, loginLabel } = validateOptions(options, env)
	// 呼び出し時点で分かる DISCORD_BASE_URL の誤設定は起動時に止める（実行時にも同じ検証をする）
	try {
		checkBaseUrl(env.DISCORD_BASE_URL, env.NODE_ENV === "production")
	} catch (e) {
		throw new Error(`[emdash-auth-discord] invalid environment: ${e.message}`)
	}
	return {
		id: "discord",
		// EmDash はこの label を admin.jsx に渡す仮想モジュールへ埋め込む。ログインボタンの文言として使う
		label: loginLabel,
		adminEntry: p("./admin.jsx"),
		routes: [
			{ pattern: "/_emdash/api/auth/discord/login", entrypoint: p("./routes/login.js") },
			{ pattern: "/_emdash/api/auth/discord/callback", entrypoint: p("./routes/callback.js") },
		],
		publicRoutes: ["/_emdash/api/auth/discord/"],
		config: {
			guildId,
			defaultRole,
			scopes,
			adminIds,
			bootstrapFirstAdmin,
			siteTitle: options.siteTitle ?? "EmDash",
			messages: options.messages ?? {},
		},
	}
}
