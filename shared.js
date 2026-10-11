import { DiscordAuthError, checkBaseUrl, messageFor, publicErrorCode } from "./lib.js"

// ネイティブプラグインは process.env を読む（import.meta.env はビルド時に埋め込まれるため使わない）。
// Cloudflare Workers（第2段階）では virtual:emdash/env を使う。
export async function getEnv(key) {
	const fromProcess = typeof process !== "undefined" ? process.env[key] : undefined
	if (fromProcess) return fromProcess
	try {
		const { env } = await import("virtual:emdash/env")
		return env?.[key]
	} catch {
		return undefined
	}
}

const isProduction = async () => (await getEnv("NODE_ENV")) === "production"

/** DISCORD_BASE_URL を検証して返す（未設定なら https://discord.com）。違反は provider_not_configured */
export const discordBaseUrl = async () => checkBaseUrl(await getEnv("DISCORD_BASE_URL"), await isProduction())

/**
 * リダイレクト URI の基になる公開 URL。EMDASH_SITE_URL（無ければ EmDash の siteUrl 設定）を使う。
 * NODE_ENV=production でどちらも無い場合は、Host ヘッダ由来の origin に頼らずエラーにする。
 */
export async function publicOrigin(request, locals) {
	const site = (await getEnv("EMDASH_SITE_URL")) || locals?.emdash?.config?.siteUrl
	if (site) {
		let u
		try { u = new URL(site) } catch { u = null }
		if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) {
			throw new DiscordAuthError("provider_not_configured", "EMDASH_SITE_URL is not a valid http(s) URL", { setting: "EMDASH_SITE_URL" })
		}
		return site.replace(/\/$/, "")
	}
	if (await isProduction()) {
		throw new DiscordAuthError("provider_not_configured", "EMDASH_SITE_URL is required when NODE_ENV=production", { missing: ["EMDASH_SITE_URL"] })
	}
	return new URL(request.url).origin
}

export const getConfig = (locals) => locals.emdash?.config?.authProviders?.find((p) => p.id === "discord")?.config ?? {}

/**
 * 失敗理由をサーバーログに残し（シークレット・トークン・認可コードは渡さないこと）、
 * ログイン画面へコードごとの固定文言で戻す。
 */
export function fail(redirect, code, { messages, log = {} } = {}) {
	const publicCode = publicErrorCode(code)
	console.warn("[discord-auth] login failed:", code, log)
	return redirect(`/_emdash/admin/login?error=${encodeURIComponent(publicCode)}&message=${encodeURIComponent(messageFor(publicCode, messages))}`)
}
