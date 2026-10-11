import { DiscordAuthError, buildAuthorizeUrl, codeChallengeS256, createCodeVerifier, createState } from "../lib.js"
import { discordBaseUrl, fail, getConfig, getEnv, publicOrigin } from "../shared.js"

export const prerender = false

export const GET = async ({ request, session, redirect, locals }) => {
	const cfg = getConfig(locals)
	const messages = cfg.messages
	const clientId = await getEnv("DISCORD_CLIENT_ID")
	// どの設定が欠けているかをサーバーログに出す（値そのものは出さない）
	const missing = [
		!clientId && "DISCORD_CLIENT_ID",
		!(await getEnv("DISCORD_CLIENT_SECRET")) && "DISCORD_CLIENT_SECRET",
		!cfg.guildId && "guildId",
	].filter(Boolean)
	if (missing.length > 0) return fail(redirect, "provider_not_configured", { messages, log: { missing } })
	if (!session) return fail(redirect, "server_error", { messages, log: { reason: "session unavailable" } })

	let origin, baseUrl
	try {
		origin = await publicOrigin(request, locals)
		baseUrl = await discordBaseUrl()
	} catch (e) {
		if (e instanceof DiscordAuthError) return fail(redirect, e.code, { messages, log: e.details })
		throw e
	}
	const state = createState()
	const verifier = createCodeVerifier()
	session.set("discord_oauth", { state, at: Date.now(), verifier })
	return redirect(
		buildAuthorizeUrl({
			baseUrl,
			clientId,
			redirectUri: `${origin}/_emdash/api/auth/discord/callback`,
			scopes: cfg.scopes,
			state,
			codeChallenge: await codeChallengeS256(verifier),
		}),
	)
}
