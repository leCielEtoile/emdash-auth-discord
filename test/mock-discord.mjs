import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { createServer } from "node:http"
import { pathToFileURL } from "node:url"

export const GUILD = "100000000000000001"
export const USERS = {
	a: { profile: { id: "200000000000000001", username: "alice_a", global_name: "Alice", avatar: "abc123", email: "a@example.test", verified: true, locale: "ja" }, guilds: [{ id: GUILD }, { id: "999" }] },
	b: { profile: { id: "200000000000000002", username: "outsider_b", global_name: "Outsider", avatar: null, email: "b@example.test", verified: true, locale: "en-US" }, guilds: [{ id: "999" }] },
	c: { profile: { id: "200000000000000003", username: "member_c", global_name: null, avatar: "def456", email: "c@example.test", verified: true, locale: "ja" }, guilds: [{ id: GUILD }] },
	d: { profile: { id: "200000000000000004", username: "noverify_d", global_name: "Unverified", avatar: null, email: "d@example.test", verified: false, locale: "ja" }, guilds: [{ id: GUILD }] },
	e: { profile: { id: "200000000000000005", username: "admin_e", global_name: "Admin E", avatar: null, email: "e@example.test", verified: true, locale: "ja" }, guilds: [{ id: GUILD }] },
}
const json = (res, s, b) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)) }

// テスト専用のモック Discord サーバー。固定シークレットで任意のユーザー（?as=）としてトークンを発行し、
// redirect_uri も検証しないため、本番では絶対に起動・参照しないこと。
// - NODE_ENV=production では起動を拒否する
// - 127.0.0.1 にのみ bind する（外部からは到達できない）
export const MOCK_HOST = "127.0.0.1"

export function startMockDiscord(port = 4400) {
	if (typeof process !== "undefined" && process.env.NODE_ENV === "production") {
		throw new Error("mock-discord is for tests only and refuses to start when NODE_ENV=production")
	}
	const challenges = new Map()
	const server = createServer(async (req, res) => {
		const u = new URL(req.url, "http://x")
		if (u.pathname === "/oauth2/authorize") {
			const to = new URL(u.searchParams.get("redirect_uri"))
			if (u.searchParams.get("deny")) to.searchParams.set("error", "access_denied")
			else {
				const code = "code-" + (u.searchParams.get("as") ?? "a")
				// PKCE: code_challenge が来たら、トークン交換で code_verifier を検証する
				if (u.searchParams.get("code_challenge")) challenges.set(code, u.searchParams.get("code_challenge"))
				to.searchParams.set("code", code)
			}
			to.searchParams.set("state", u.searchParams.get("state"))
			res.writeHead(302, { Location: to.toString() }); return res.end()
		}
		if (u.pathname === "/api/oauth2/token" && req.method === "POST") {
			let body = ""; for await (const c of req) body += c
			const p = new URLSearchParams(body)
			const user = (p.get("code") ?? "").replace("code-", "")
			if (!USERS[user] || p.get("client_secret") !== "mock-secret") return json(res, 400, { error: "invalid_grant" })
			const challenge = challenges.get(p.get("code"))
			if (challenge) {
				challenges.delete(p.get("code"))
				const actual = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url")
				if (actual !== challenge) return json(res, 400, { error: "invalid_grant" })
			}
			return json(res, 200, { access_token: "tok-" + user, token_type: "Bearer" })
		}
		const user = (req.headers.authorization ?? "").replace("Bearer tok-", "")
		if (!USERS[user]) return json(res, 401, { message: "401: Unauthorized" })
		if (u.pathname === "/api/users/@me") return json(res, 200, USERS[user].profile)
		if (u.pathname === "/api/users/@me/guilds") return json(res, 200, USERS[user].guilds)
		json(res, 404, {})
	})
	return new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(port, MOCK_HOST, () => resolve(server))
	})
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	const server = await startMockDiscord(Number(process.env.PORT ?? 4400))
	console.log(`mock discord listening on http://${MOCK_HOST}:${server.address().port} (tests only)`)
}
