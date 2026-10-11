import * as React from "react"
// EmDash が生成する仮想モジュール。discord({ loginLabel }) の値がこのプロバイダの label として入る
// （このファイル自身もこの仮想モジュールから読み込まれる。参照は描画時なので循環しても問題ない）
import { authProviders } from "virtual:emdash/auth-providers"
import { DEFAULT_LOGIN_LABEL } from "./lib.js"

/** ログイン画面に表示するボタン（EmDash が virtual module 経由で描画） */
export function LoginButton() {
	const label = authProviders?.discord?.label || DEFAULT_LOGIN_LABEL
	return (
		<a
			href="/_emdash/api/auth/discord/login"
			style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", padding: "8px 12px", border: "1px solid currentColor", borderRadius: 8, textDecoration: "none", color: "inherit", fontWeight: 600 }}
		>
			{label}
		</a>
	)
}
