import { describe, it, expect, afterEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { readFileSync } from "node:fs"
import { authProviders } from "./support/auth-providers.js"
import { LoginButton } from "../admin.jsx"
import { discord } from "../index.js"

afterEach(() => { authProviders.discord.label = undefined })

describe("LoginButton", () => {
	it("既定の文言は英語の Log in with Discord で、login ルートへのリンク", () => {
		const html = renderToStaticMarkup(<LoginButton />)
		expect(html).toContain("Log in with Discord")
		expect(html).toContain('href="/_emdash/api/auth/discord/login"')
	})
	it("discord({ loginLabel }) の値（EmDash が label として渡す）を表示する", () => {
		authProviders.discord.label = discord({ loginLabel: "Discord でログイン" }).label
		expect(renderToStaticMarkup(<LoginButton />)).toContain("Discord でログイン")
	})
	it("loginLabel 未指定なら label は英語の既定、空文字・文字列以外は拒否", () => {
		expect(discord({}).label).toBe("Log in with Discord")
		expect(() => discord({ loginLabel: "" })).toThrowError(/loginLabel/)
		expect(() => discord({ loginLabel: 1 })).toThrowError(/loginLabel/)
	})
	it("admin.jsx に日本語の固定文言が残っていない", () => {
		const code = readFileSync(new URL("../admin.jsx", import.meta.url), "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/**"))
		expect(code.join("\n")).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/)
	})
})
