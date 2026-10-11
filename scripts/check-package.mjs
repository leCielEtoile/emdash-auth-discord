// 使い方: node scripts/check-package.mjs [パッケージのディレクトリ]（省略時はこのスクリプトの親 = リポジトリ直下）
// 公開パッケージとして問題がないかを検査する。違反があれば一覧を出して終了コード 1（検査自体が失敗した場合も 1）。
// 検査対象は「実際に公開物へ同梱されるファイル」（pnpm pack --dry-run --json の一覧）。test/ なども同梱されるなら対象になる。
//   (a) パッケージの外を指す参照がない（相対パスの文字列・import/require/new URL の絶対パスや file: URL）
//   (b) 非公開語（外部ファイルで指定。無ければスキップ）と、秘密情報・ホームパス・内部ホスト名などの機微情報を含まない
//   (c) package.json の必須項目が揃っている
//   (d) README.md がある
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const CODE_EXT = /\.(?:[cm]?[jt]sx?|html?|vue|svelte|astro)$/i
const REQUIRED_MANIFEST = ["name", "version", "type", "exports", "files", "peerDependencies", "license", "repository", "scripts"]

// 非公開語は外部ファイルで管理する（リポジトリには語を一切書かない）。
//   既定: パッケージ直下の .check-package.private-terms（gitignore 済み）。環境変数 CHECK_PACKAGE_PRIVATE_TERMS_FILE でパス指定も可。
//   書式: 1行1語。# 始まりはコメント、空行は無視。大文字小文字を区別せず部分一致（NFKC 正規化後に照合）。
//         半角/全角・空白/ハイフンなどの表記揺れは、揺れごとに別の行として書く。
//   ファイルが無い場合は検査をスキップする（失敗にはしない）。
const PRIVATE_TERMS_FILE = ".check-package.private-terms"
const PRIVATE_TERMS_ENV = "CHECK_PACKAGE_PRIVATE_TERMS_FILE"
const foldTerm = (s) => s.normalize("NFKC").replace(/[​-‏⁠﻿]/g, "").toLowerCase()

export function privateTermsPath(root, env = process.env) {
	return env[PRIVATE_TERMS_ENV] ? resolve(env[PRIVATE_TERMS_ENV]) : join(root, PRIVATE_TERMS_FILE)
}

/** 非公開語ファイルを読む。無ければ null（スキップ） */
export function loadPrivateTerms(root, env = process.env) {
	const path = privateTermsPath(root, env)
	if (!existsSync(path)) return null
	const terms = readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(foldTerm).filter(Boolean)
	return { path, terms }
}

const mentionsPrivate = (text, terms) => {
	const t = foldTerm(text)
	return terms.some((w) => t.includes(w))
}

// 汎用の機微情報パターン（公開 OSS として同梱してはいけないもの）
const PLACEHOLDER_USER = "(?!(?:someone|user|username|you|name|example|runner)\\b)"
const SENSITIVE = [
	{ label: "秘密鍵", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
	{ label: "トークン", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|npm_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{32,})\b/ },
	{ label: "ユーザーホームのパス", re: new RegExp(`(?:/Users/|/home/|[A-Za-z]:\\\\+Users\\\\+)${PLACEHOLDER_USER}[A-Za-z0-9._-]+`, "i") },
	{ label: "内部ホスト名・私設 IP", re: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|corp|lan|intranet|local)\b|\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/i },
]
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g
const SAFE_EMAIL_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|[a-z0-9-]+\.(?:test|invalid|example|localhost))$|^users\.noreply\.github\.com$|^noreply\./i

/** 機微情報の疑いのあるパターンのラベル一覧 */
export function findSensitive(text) {
	const out = SENSITIVE.filter(({ re }) => re.test(text)).map((s) => s.label)
	for (const m of text.matchAll(EMAIL)) if (!SAFE_EMAIL_DOMAIN.test(m[1])) { out.push("メールアドレス"); break }
	return out
}

/** pnpm pack --dry-run --json で、実際に同梱されるファイルの一覧（パッケージ直下からの相対パス）を得る */
export function listPackedFiles(root) {
	const r = spawnSync("pnpm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" })
	if (r.error || r.status !== 0) throw new Error(`pnpm pack --dry-run に失敗しました: ${r.error?.message ?? r.stderr?.trim()}`)
	const json = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")))
	if (!Array.isArray(json.files)) throw new Error("pnpm pack --json の出力に files がありません")
	return json.files.map((f) => f.path)
}

// import / export ... from / 動的 import() / require() の指定先（空白なし・テンプレートリテラルも拾う）
const IMPORT_SPEC = /(?<![\w$.])(?:from|import|require)\s*\(?\s*(["'`])([^"'`\n]+)\1/g
// new URL("...", ...) の参照先
const URL_SPEC = /new\s+URL\(\s*(["'`])([^"'`\n]+)\1/g
// ./ や ../ で始まる文字列リテラルはすべて（ヘルパー関数経由の参照も拾うため）
const RELATIVE_LITERAL = /(["'`])(\.{1,2}\/[^"'`\n]*)\1/g
const ABSOLUTE_SPEC = /^(?:\/|file:|[A-Za-z]:[\\/])/

function escapes(root, file, spec) {
	const r = relative(root, resolve(dirname(file), spec))
	return r === ".." || r.startsWith(".." + "/") || r.startsWith("..\\") || isAbsolute(r)
}

export function findViolations(pkgDir, { env = process.env } = {}) {
	const root = resolve(pkgDir)
	const priv = loadPrivateTerms(root, env)
	const violations = []
	const add = (rule, file, detail) => violations.push({ rule, file, detail })

	const manifestPath = join(root, "package.json")
	if (!existsSync(manifestPath)) add("manifest", "package.json", "package.json がありません")
	else {
		let m
		try { m = JSON.parse(readFileSync(manifestPath, "utf8")) } catch (e) { add("manifest", "package.json", `JSON として読めません: ${e.message}`) }
		if (m) {
			for (const key of REQUIRED_MANIFEST) if (m[key] === undefined) add("manifest", "package.json", `${key} がありません`)
			if (m.scripts && !m.scripts.test) add("manifest", "package.json", "scripts.test がありません")
			if (m.type !== undefined && m.type !== "module") add("manifest", "package.json", 'type は "module" にしてください')
		}
		// package.json が読めないと同梱一覧も得られないので、ここで打ち切る
		if (!m) return violations
	}
	if (!existsSync(join(root, "README.md"))) add("readme", "README.md", "README.md がありません")
	if (!existsSync(manifestPath)) return violations

	for (const rel of listPackedFiles(root)) {
		if (priv && mentionsPrivate(rel, priv.terms)) add("no-private-terms", rel, "ファイル名に非公開語（外部ファイル指定）を含みます")
		const file = join(root, rel)
		const buf = readFileSync(file)
		if (buf.includes(0)) continue // バイナリは対象外
		const text = buf.toString("utf8")
		if (CODE_EXT.test(rel)) {
			const seen = new Set()
			const report = (spec, kind) => {
				if (seen.has(spec)) return
				seen.add(spec)
				add("no-escaping-import", rel, `パッケージの外を指す${kind}: ${spec}`)
			}
			for (const re of [IMPORT_SPEC, URL_SPEC]) {
				for (const m of text.matchAll(re)) {
					const spec = m[2]
					if (ABSOLUTE_SPEC.test(spec)) report(spec, "絶対パス参照")
					else if (spec.startsWith(".") && escapes(root, file, spec)) report(spec, "参照")
				}
			}
			for (const m of text.matchAll(RELATIVE_LITERAL)) if (escapes(root, file, m[2])) report(m[2], "相対パス")
		}
		if (priv && mentionsPrivate(text, priv.terms)) add("no-private-terms", rel, "非公開語（外部ファイル指定）を含みます。オプションで受け取ってください")
		for (const label of findSensitive(text)) add("no-sensitive-info", rel, `機微情報の疑い: ${label}`)
	}
	return violations
}

// 直接実行の判定は realpath ベース（シンボリックリンク・空白を含むパスでも動く）
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
	try {
		const here = dirname(fileURLToPath(import.meta.url))
		const dir = process.argv[2] ?? join(here, "..")
		const v = findViolations(dir)
		if (!loadPrivateTerms(resolve(dir))) console.log("INFO private terms check skipped（外部ファイルが無いためスキップ）")
		console.log(`${v.length === 0 ? "OK  " : "NG  "} ${relative(process.cwd(), dir) || dir}`)
		for (const x of v) console.log(`     [${x.rule}] ${x.file}: ${x.detail}`)
		process.exit(v.length ? 1 : 0)
	} catch (e) {
		// 検査できなかった場合は成功扱いにしない（フェイルクローズ）
		console.error(`NG   検査に失敗しました: ${e instanceof Error ? e.message : e}`)
		process.exit(1)
	}
}
