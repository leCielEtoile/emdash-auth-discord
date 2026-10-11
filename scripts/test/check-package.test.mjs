import { describe, it, expect } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { findViolations, loadPrivateTerms, listPackedFiles } from "../check-package.mjs"

// 非公開語はテスト内でダミー語を一時ファイルに書いて検証する（実在の固有名は書かない）
const TERM = "acme-secret-term"
const termsFile = (content) => {
	const d = mkdtempSync(join(tmpdir(), "terms-"))
	const p = join(d, "terms.txt")
	writeFileSync(p, content)
	return p
}
const withTerms = (content) => ({ env: { CHECK_PACKAGE_PRIVATE_TERMS_FILE: termsFile(content) } })
const NO_TERMS = { env: {} }

const BASE_PKG = {
	name: "emdash-x", version: "0.1.0", type: "module", exports: { ".": "./index.js" },
	peerDependencies: { emdash: ">=1.1.0" }, license: "MIT", repository: { type: "git", url: "git+https://example.test/x.git" },
	scripts: { test: "vitest run" },
}
/** files を書いたパッケージを作る。manifest.files 省略時は書いたファイルの最上位の名前をすべて同梱対象にする */
function pkg(files, manifest = {}) {
	const dir = mkdtempSync(join(tmpdir(), "chk-"))
	const packed = [...new Set(Object.keys(files).map((f) => f.split("/")[0]))]
	writeFileSync(join(dir, "package.json"), JSON.stringify({ ...BASE_PKG, files: packed.length ? packed : ["index.js"], ...manifest }))
	writeFileSync(join(dir, "README.md"), "# x\n")
	for (const [name, body] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true })
		writeFileSync(join(dir, name), body)
	}
	return dir
}
const clean = (...dirs) => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }))
const escaping = (dir) => findViolations(dir).filter((m) => m.rule === "no-escaping-import")
const privateTerms = (dir, opts) => findViolations(dir, opts).filter((m) => m.rule === "no-private-terms").map((m) => m.file)

describe("findViolations", () => {
	it("条件を満たすパッケージは違反なし", () => {
		const dir = pkg({ "index.js": 'import { a } from "./lib.js"\nexport const b = a\n', "lib.js": "export const a = 1\n" })
		try { expect(findViolations(dir)).toEqual([]) } finally { clean(dir) }
	})
	it("パッケージの外を指す相対 import を検出する（静的・動的・export from）", () => {
		const dir = pkg({ "index.js": 'import x from "../../outside.js"\nexport { y } from "../other.js"\nconst z = await import("../../dyn.js")\n' })
		try { expect(escaping(dir).length).toBe(3) } finally { clean(dir) }
	})
	it("パッケージ内に収まる相対 import（../ を使っても）は違反にしない", () => {
		const dir = pkg({ "routes/a.js": 'import { x } from "../lib.js"\nexport const y = x\n', "lib.js": "export const x = 1\n" }, { exports: { ".": "./lib.js" } })
		try { expect(findViolations(dir)).toEqual([]) } finally { clean(dir) }
	})
	it("同梱されるファイルだけが対象: files に無いファイルは見ないが、同梱される test/ は見る", () => {
		const dir = pkg({ "index.js": "export {}\n", "scripts/x.js": 'import "../../out.js"\n', "test/mock.mjs": 'import "../../out2.js"\n' }, { files: ["index.js", "test/mock.mjs"] })
		try {
			expect(listPackedFiles(dir)).toEqual(expect.arrayContaining(["index.js", "test/mock.mjs"]))
			expect(listPackedFiles(dir)).not.toContain("scripts/x.js")
			expect(escaping(dir).map((m) => m.file)).toEqual(["test/mock.mjs"])
		} finally { clean(dir) }
	})
	it("package.json の必須項目（license / repository を含む）の欠落を検出する", () => {
		const dir = pkg({ "index.js": "export {}\n" })
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.1.0", type: "module" }))
		try {
			const details = findViolations(dir).filter((m) => m.rule === "manifest").map((m) => m.detail)
			expect(details).toEqual(expect.arrayContaining(["license がありません", "repository がありません", "exports がありません"]))
		} finally { clean(dir) }
	})
	it("type が module でなければ違反。壊れた package.json はクラッシュせず違反として報告する", () => {
		const dir = pkg({ "index.js": "export {}\n" }, { type: "commonjs" })
		try { expect(findViolations(dir).some((m) => m.detail.includes("module"))).toBe(true) } finally { clean(dir) }
		const dir2 = pkg({ "index.js": "export {}\n" })
		writeFileSync(join(dir2, "package.json"), "{ not json")
		try { expect(findViolations(dir2).some((m) => m.rule === "manifest")).toBe(true) } finally { clean(dir2) }
	})
	it("README.md の欠落を検出する", () => {
		const dir = pkg({ "index.js": "export {}\n" })
		rmSync(join(dir, "README.md"))
		try { expect(findViolations(dir).map((m) => m.rule)).toContain("readme") } finally { clean(dir) }
	})
	it("node_modules は走査しない", () => {
		const dir = pkg({ "index.js": "export {}\n", "node_modules/dep/i.js": 'import "../../../../x.js"\n' }, { files: ["index.js"] })
		try { expect(findViolations(dir)).toEqual([]) } finally { clean(dir) }
	})
})

describe("回避の手口（レビュー M2）も検出する", () => {
	it.each([
		["空白なし import", "index.js", 'import{a}from"../../outside-nospace.js"\nexport default a\n'],
		["createRequire 経由の require", "index.js", 'import { createRequire } from "node:module"\nconst r = createRequire(import.meta.url)("../../outside-require.cjs")\n'],
		["require", "index.cjs", 'module.exports = require("../../outside.cjs")\n'],
		["テンプレートリテラルの動的 import", "index.js", "const m = await import(`../../outside-template.js`)\n"],
		["ヘルパー関数経由の new URL", "index.js", 'import { fileURLToPath } from "node:url"\nconst p = (rel) => fileURLToPath(new URL(rel, import.meta.url))\nexport const x = p("../../outside-helper.js")\n'],
		["絶対パスの import", "index.js", 'const m = await import("/Users/someone/private/app/lib.js")\n'],
		["file: URL の import", "index.js", 'import x from "file:///Users/someone/private/app/lib.js"\n'],
		["new URL の外側参照", "index.js", 'export const a = new URL("../x", import.meta.url)\n'],
		[".mts", "index.mts", 'import x from "../../outside.js"\n'],
		[".html", "page.html", '<script type="module">import x from "../../outside.js"</script>\n'],
	])("%s", (_name, file, body) => {
		const dir = pkg({ [file]: body })
		try { expect(escaping(dir).length).toBeGreaterThan(0) } finally { clean(dir) }
	})
	it("内側の new URL・相対パスは許す", () => {
		const dir = pkg({ "index.js": 'export const b = new URL("./ok.json", import.meta.url)\nconst p = (r) => r\nexport const c = p("./admin.jsx")\n' })
		try { expect(escaping(dir)).toEqual([]) } finally { clean(dir) }
	})
})

describe("非公開語（外部ファイル）", () => {
	it("同梱ファイルの本文・ファイル名・README・test/ を検査する（大文字小文字を区別しない）", () => {
		const dir = pkg({ "index.js": "export {}\n", "test/mock.mjs": `export const u = "${TERM.toUpperCase()}"\n`, [`${TERM}.txt`]: "ok" })
		writeFileSync(join(dir, "README.md"), `# ${TERM}\n`)
		try {
			const files = privateTerms(dir, withTerms(`${TERM}\n`))
			expect(files).toEqual(expect.arrayContaining(["test/mock.mjs", "README.md", `${TERM}.txt`]))
			expect(files).not.toContain("index.js")
		} finally { clean(dir) }
	})
	it("表記揺れ（全角・半角カナ）は NFKC 正規化で同一視し、空白・ハイフン違いは別行で指定する", () => {
		const dir = pkg({ "a.cjs": 'module.exports = "ＡＣＭＥ－ＳＥＣＲＥＴ－ＴＥＲＭ"\n', "b.js": 'export const t = "acme secret term"\n', "c.js": 'export const t = "ﾃｽﾄ語"\n' })
		try {
			expect(privateTerms(dir, withTerms(`${TERM}\nacme secret term\nテスト語\n`)).sort()).toEqual(["a.cjs", "b.js", "c.js"])
			expect(privateTerms(dir, withTerms("ﾃｽﾄ語\n"))).toEqual(["c.js"])
		} finally { clean(dir) }
	})
	it("複数語・コメント行・空行・CRLF を扱う", () => {
		const dir = pkg({ "a.js": 'export const t = "first-term"\n', "b.js": 'export const t = "second-term"\n', "c.js": 'export const t = "commented-term"\n', "d.js": "export const t = 1\n" })
		try {
			const f = withTerms("# コメント\r\nfirst-term\r\n\r\n  second-term  \r\n# commented-term\r\n")
			expect(privateTerms(dir, f).sort()).toEqual(["a.js", "b.js"])
		} finally { clean(dir) }
	})
	it("ファイルが無ければスキップして違反にしない（環境変数のパスが存在しない場合も）", () => {
		const dir = pkg({ "index.js": `export const t = "${TERM}"\n` })
		try {
			expect(findViolations(dir, NO_TERMS)).toEqual([])
			expect(findViolations(dir, { env: { CHECK_PACKAGE_PRIVATE_TERMS_FILE: join(tmpdir(), "no-such-terms-" + Date.now()) } })).toEqual([])
			expect(loadPrivateTerms(dir, NO_TERMS)).toBeNull()
		} finally { clean(dir) }
	})
	it("既定ではパッケージ直下の .check-package.private-terms を読む", () => {
		const dir = pkg({ "index.js": `export const t = "${TERM}"\n` })
		writeFileSync(join(dir, ".check-package.private-terms"), `${TERM}\n`)
		try { expect(privateTerms(dir, NO_TERMS)).toEqual(["index.js"]) } finally { clean(dir) }
	})
	it("環境変数 CHECK_PACKAGE_PRIVATE_TERMS_FILE が既定より優先される", () => {
		const dir = pkg({ "index.js": 'export const t = "env-term"\n' })
		writeFileSync(join(dir, ".check-package.private-terms"), `${TERM}\n`)
		try { expect(privateTerms(dir, withTerms("env-term\n"))).toEqual(["index.js"]) } finally { clean(dir) }
	})
	it("違反メッセージに語そのものを出さない", () => {
		const dir = pkg({ "index.js": `export const t = "${TERM}"\n` })
		try { expect(JSON.stringify(findViolations(dir, withTerms(`${TERM}\n`)))).not.toContain(TERM) } finally { clean(dir) }
	})
	it("同梱されないファイルと node_modules は検査しない", () => {
		const dir = pkg({ "index.js": "export {}\n", "docs/memo.md": TERM, "node_modules/dep/i.js": `export const c = "${TERM}"\n` }, { files: ["index.js"] })
		try { expect(findViolations(dir, withTerms(`${TERM}\n`))).toEqual([]) } finally { clean(dir) }
	})
	it("無関係な語は誤検出しない", () => {
		const dir = pkg({ "index.js": 'export const a = "acme"\nexport const b = "secret"\n' })
		try { expect(findViolations(dir, withTerms(`${TERM}\n`))).toEqual([]) } finally { clean(dir) }
	})
})

describe("汎用の機微情報検査", () => {
	it.each([
		["秘密鍵", "-----BEGIN " + "PRIVATE KEY-----"],
		["GitHub トークン", "ghp_" + "a".repeat(36)],
		["ホームパス（macOS）", "/Users/alice/work/app"],
		["ホームパス（Linux）", "/home/alice/app"],
		["ホームパス（Windows）", "C:\\Users\\alice\\app"],
		["内部ホスト名", "db.corp"],
		["私設 IP", "192.168.1.20"],
		["実在しそうなメール", "alice@mycompany.io"],
	])("検出する: %s", (_n, body) => {
		const dir = pkg({ "notes.txt": body + "\n" })
		try { expect(findViolations(dir, NO_TERMS).filter((m) => m.rule === "no-sensitive-info").map((m) => m.file)).toEqual(["notes.txt"]) } finally { clean(dir) }
	})
	it("プレースホルダ（example / someone / loopback）は許す", () => {
		const dir = pkg({ "notes.txt": "a@example.com b@x.test /Users/someone/app 127.0.0.1 https://example.com/ pkg@1.2.3\n" })
		try { expect(findViolations(dir, NO_TERMS)).toEqual([]) } finally { clean(dir) }
	})
})

describe("CLI 直接実行", () => {
	const script = join(dirname(fileURLToPath(import.meta.url)), "..", "check-package.mjs")
	it("空白を含むパスに置いたスクリプトでも走り、違反で終了コード 1", () => {
		const base = mkdtempSync(join(tmpdir(), "chk dir "))
		const dir = pkg({ "index.js": 'import x from "../../outside.js"\n' })
		try {
			const copy = join(base, "check.mjs")
			writeFileSync(copy, readFileSync(script, "utf8"))
			const r = spawnSync(process.execPath, [copy, dir], { encoding: "utf8" })
			expect(r.status).toBe(1)
			expect(r.stdout).toContain("NG")
		} finally { clean(base, dir) }
	})
	it("シンボリックリンク経由でも走る", () => {
		const base = mkdtempSync(join(tmpdir(), "chk-link-"))
		const dir = pkg({ "index.js": 'import x from "../../outside.js"\n' })
		try {
			const link = join(base, "link.mjs")
			symlinkSync(script, link)
			const r = spawnSync(process.execPath, [link, dir], { encoding: "utf8" })
			expect(r.status).toBe(1)
			expect(r.stdout).toContain("NG")
		} finally { clean(base, dir) }
	})
	it("非公開語ファイルが無いときは skipped を表示して終了コード 0", () => {
		const dir = pkg({ "index.js": `export const t = "${TERM}"\n` })
		try {
			const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8", env: { ...process.env, CHECK_PACKAGE_PRIVATE_TERMS_FILE: "" } })
			expect(r.status).toBe(0)
			expect(r.stdout).toContain("private terms check skipped")
		} finally { clean(dir) }
	})
	it("環境変数で指定した非公開語ファイルの語を検出して終了コード 1", () => {
		const dir = pkg({ "index.js": `export const t = "${TERM}"\n` })
		try {
			const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8", env: { ...process.env, ...withTerms(`${TERM}\n`).env } })
			expect(r.status).toBe(1)
			expect(r.stdout).toContain("no-private-terms")
			expect(r.stdout).not.toContain("skipped")
		} finally { clean(dir) }
	})
	it("違反のないパッケージは終了コード 0", () => {
		const dir = pkg({ "index.js": "export {}\n" })
		try { expect(spawnSync(process.execPath, [script, dir], { encoding: "utf8" }).status).toBe(0) } finally { clean(dir) }
	})
	it("存在しないディレクトリなど検査自体が失敗したら終了コード 1（フェイルクローズ）", () => {
		const r = spawnSync(process.execPath, [script, join(tmpdir(), "no-such-dir-" + Date.now())], { encoding: "utf8" })
		expect(r.status).toBe(1)
	})
})
