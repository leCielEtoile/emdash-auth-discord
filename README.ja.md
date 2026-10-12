# emdash-auth-discord

[English](./README.md) | 日本語

EmDash 用の Discord ログイン（認証プロバイダ）。指定したギルド（サーバー）に在籍しているメンバーだけがログインできる。

## 概要

- Discord OAuth2（authorization code + PKCE/S256）でログインする。ログイン画面に「Log in with Discord」ボタンを出す（文言は `loginLabel` で変更できる）。
- `guilds` スコープでギルド一覧（200 件ずつ最大 10 ページ）を取得し、`guildId` に在籍していなければ拒否する。
- Discord のメールが未認証の場合は拒否する（`email_not_verified`）。
- ログインのたびに表示名・アバターを同期し、`users.data.discord` にログイン回数などを記録する。
- ロールは「`adminIds` に載っていれば Admin、それ以外は `defaultRole`（既定 `10` = Subscriber）」。`bootstrapFirstAdmin` を明示的に有効にしない限り、誰も自動では Admin にならない。
- Admin が Discord でログインしたとき、EmDash の初期セットアップ（`emdash:setup_complete`）が未完了なら完了させる。

> **警告: ギルド在籍だけがログインの条件になる。** `guildId` のメンバーは全員ログインでき、`defaultRole` のロールで登録される。公開招待リンクなどで誰でもギルドに参加できるなら、誰でもそのロールを得られる。`defaultRole` は必要最小限にし、上位のロールは EmDash 側で個別に付与すること。

## 必要なもの

- Node.js >= 22
- ピア依存（アプリ側が提供する）: `emdash >=1.1.0 <2`、`@emdash-cms/auth >=1.1.0 <2`、`react >=18`。`emdash` 1.2.0 で動作確認。
- OAuth2 を有効にした Discord アプリケーション

## インストール

npm から入れる。

```bash
pnpm add emdash-auth-discord
```

リリースはこのリポジトリのリリースワークフローが [npm provenance](https://docs.npmjs.com/generating-provenance-statements) 付きで公開するため、npm のページは `github.com/leCielEtoile/emdash-auth-discord` を指す。バージョンを固定するときは `pnpm add emdash-auth-discord@<バージョン>`（例: `0.1.2`）とする。

## セットアップ

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリケーションを作る。Bot は不要。
2. **OAuth2** で **Client ID** と **Client Secret** を控え、リダイレクト URI を登録する。

   ```
   <公開 URL>/_emdash/api/auth/discord/callback
   ```

   `<公開 URL>` は `EMDASH_SITE_URL` と完全に一致させる（スキーム・ホスト・ポート）。
3. ギルド ID を調べる: Discord の **設定 > 詳細設定 > 開発者モード** を有効にし、サーバーを右クリックして **サーバー ID をコピー**。`adminIds` 用に自分のユーザー ID も同じ方法（名前を右クリック > **ユーザー ID をコピー**）で控える。
4. 環境変数を設定する（例: `.env`。コミットしないこと）。

   ```bash
   DISCORD_CLIENT_ID=123456789012345678
   DISCORD_CLIENT_SECRET=your-client-secret
   DISCORD_GUILD_ID=100000000000000001      # 下の設定例で読む
   DISCORD_ADMIN_IDS=200000000000000001     # 自分の Discord ユーザー ID
   EMDASH_SITE_URL=https://cms.example.com
   ```

5. `astro.config.mjs` にプロバイダを追加する。画面の文言を日本語にする場合は `loginLabel` と `messages` で上書きする。

   ```js
   import { defineConfig } from "astro/config"
   import emdash from "emdash/astro"
   import { discord } from "emdash-auth-discord"

   export default defineConfig({
   	integrations: [
   		emdash({
   			authProviders: [
   				discord({
   					guildId: process.env.DISCORD_GUILD_ID,
   					defaultRole: 10,
   					siteTitle: "My Site",
   					loginLabel: "Discord でログイン",
   					messages: {
   						notGuildMember: "My Site の Discord サーバーのメンバーのみログインできます。",
   						invalidState: "認証セッションが無効または期限切れです。もう一度お試しください。",
   						emailNotVerified: "Discord のメールアドレスを認証してから、もう一度お試しください。",
   						accountDisabled: "このアカウントは無効化されています。",
   						rateLimited: "Discord が混み合っています。しばらく待ってから、もう一度お試しください。",
   						oauthError: "ログインできませんでした。もう一度お試しください。",
   					},
   				}),
   			],
   		}),
   	],
   })
   ```

## オプション（`discord({...})`）

オプションは `discord()` の呼び出し時に検証する。不正な値はログイン時に黙って失敗するのではなく、起動時にエラーになる。

| オプション | 型 | 既定 | 説明 |
| --- | --- | --- | --- |
| `guildId` | `string`（17〜20 桁） | なし（必須） | 在籍を確認するギルド ID。数値だと精度が落ちるので文字列で渡す。未設定ならログインは全員拒否（フェイルクローズ） |
| `defaultRole` | `10 \| 20 \| 30 \| 40` | `10`（Subscriber） | 管理者以外の新規ユーザーのロール。`50`（Admin）は指定できない（`adminIds` を使う） |
| `adminIds` | `string[]`（各 17〜20 桁） | `[]` | Admin にする Discord ユーザー ID。環境変数 `DISCORD_ADMIN_IDS` との和集合 |
| `bootstrapFirstAdmin` | `boolean` | `false` | `true`（または `DISCORD_BOOTSTRAP_FIRST_ADMIN=1`）のとき、EmDash の初期セットアップ完了前に限り、最初にログインした在籍メンバー 1 人を Admin にする（後述） |
| `scopes` | `string[]` | `["identify","email","guilds"]` | 要求する OAuth スコープ。既定の 3 つは必須 |
| `siteTitle` | `string` | `"EmDash"` | 初期セットアップ完了時、サイト名が未設定ならこの値を入れる |
| `loginLabel` | `string` | `"Log in with Discord"` | ログインボタンの文言 |
| `messages` | `Record<string, string>` | 英語の既定文言 | ログイン画面に出す文言。キーはエラーコードの camelCase（下記） |

ロールの値: `10` Subscriber、`20` Contributor、`30` Author、`40` Editor、`50` Admin。

`messages` のキー: `providerNotConfigured`、`serverError`、`invalidCallback`、`invalidState`、`oauthDenied`、`notGuildMember`、`emailRequired`、`emailNotVerified`、`signupNotAllowed`、`accountDisabled`、`userNotFound`、`rateLimited`、`discordTimeout`、`tokenExchangeFailed`、`profileFetchFailed`、`guildFetchFailed`、`oauthError`。未知のキーはエラーになる。

## 環境変数

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `DISCORD_CLIENT_ID` | 必須 | OAuth2 クライアント ID |
| `DISCORD_CLIENT_SECRET` | 必須（秘密） | OAuth2 クライアントシークレット。コミット・ログ出力しない |
| `DISCORD_ADMIN_IDS` | 任意 | Admin にする Discord ユーザー ID（17〜20 桁、カンマ区切り）。`adminIds` と和集合。不正な ID は無視されず、ログインが `provider_not_configured` で失敗する |
| `DISCORD_BOOTSTRAP_FIRST_ADMIN` | 任意 | `1` で `bootstrapFirstAdmin` を有効にする。それ以外の値では無効 |
| `EMDASH_SITE_URL` | 本番では必須 | 公開 URL。リダイレクト URI の生成に使う。未設定なら EmDash の `siteUrl` 設定を使う。`NODE_ENV=production` でどちらも無い場合は `provider_not_configured` で失敗する（Host ヘッダを信用しない）。開発時はリクエストの origin を使う |
| `DISCORD_BASE_URL` | 任意（テスト専用） | Discord のベース URL（既定 `https://discord.com`）。`https`、または `localhost` / `127.0.0.1` の `http` のみ受け付ける。`NODE_ENV=production` では `https://discord.com` 以外はエラー |
| `NODE_ENV` | 推奨 | 本番では `production` にして、上記の検査を有効にする |

`guildId` / `defaultRole` などの設定は環境変数ではなくオプションで渡す（アプリ側で `process.env` を読んで渡す）。

## 動作の仕様

- 失敗時は `/_emdash/admin/login?error=<コード>&message=<文言>` へ戻す。文言はコードごとの固定文言（既定は英語、`messages` で上書き可）で、Discord の `error_description` や内部エラーの文言は表示しない。コード: `provider_not_configured`、`server_error`、`invalid_callback`、`invalid_state`、`oauth_denied`、`not_guild_member`、`email_required`、`email_not_verified`、`signup_not_allowed`、`account_disabled`、`user_not_found`、`rate_limited`、`discord_timeout`、`token_exchange_failed`、`profile_fetch_failed`、`guild_fetch_failed`、`oauth_error`。
- 失敗はすべてサーバーログに `[discord-auth] login failed: <コード> {...}` として、秘密でない補足（HTTP ステータス・`Retry-After`・欠けている設定名）付きで残す。クライアントシークレット・アクセストークン・認可コードは出さない。
- Discord API の呼び出しは 1 回 10 秒でタイムアウトする（`discord_timeout`）。429 は `rate_limited` として `Retry-After` をログに出す。再試行はしない。
- `state` はセッションから読み出した直後に破棄してから検証するので、使用済み・検証失敗の `state` は再利用できない。期限は 10 分。トークン交換には PKCE（S256）を使う。ログイン成功時にセッション ID を再生成する（セッション固定化対策）。
- ロール決定: Discord ID が管理者 ID（`adminIds` ∪ `DISCORD_ADMIN_IDS`）にあれば Admin(50)。そうでなく、`bootstrapFirstAdmin` が有効 **かつ** `emdash:setup_complete` が未設定なら、最初にログインした 1 人を Admin にする（その際は警告ログを出す）。それ以外は `defaultRole`。
- 管理者 ID に載った既存ユーザーは次回ログインで Admin に昇格する。自動降格はしない。
- ログイン記録: `users.data.discord` に Discord ID・ユーザー名・ロケール・初回/最終ログイン時刻・ログイン回数を保存する。

## セキュリティ上の注意と制限事項

- `DISCORD_CLIENT_SECRET` はリポジトリやログに残さない。
- 管理者は `adminIds` で指定するのが基本。`bootstrapFirstAdmin` は初回デプロイ時だけ有効にし、他の人より先に自分でログインしてから、`adminIds` を設定して無効に戻す。「最初の Admin」の枠は `options` テーブルへの `INSERT ... ON CONFLICT DO NOTHING` で原子的に確保するので、同時ログインで 2 人とも Admin になることはなく、セットアップ完了後に付与されることもない。
- **ギルドから脱退・BAN されても既存のセッションは切れない。** 在籍確認はログイン時だけ。すぐに締め出すには EmDash 側でユーザーを無効化する（無効化ユーザーはログイン時に拒否される）。
- **アカウントは認証済みメールで紐付く。** Discord アカウントの認証済みメールが既存の EmDash ユーザー（パスキーで作った Admin を含む）と同じなら、Discord でログインするとそのユーザーとしてログインする。そのアカウントの強度が Discord アカウント側の強度まで下がる。パスキーの Admin と、信頼しきれない Discord アカウントで同じメールを使わないこと（または該当する EmDash ユーザーを無効化する）。無効化ユーザーは紐付けを作る前に拒否する。
- **表示名とアバターはログインのたびに Discord の値で上書きされる。** Discord の表示名は本人が自由に変えられるので、EmDash 上の表示名で本人確認をしないこと。
- `state` はセッション単位で 1 回限りだが、Astro はセッションの変更をレスポンス完了時に保存するため、同じ Cookie と `state` で並行に送られた 2 つのリクエストは両方とも検証を通りうる。Discord の認可コードは 1 回しか使えず、PKCE も必須なので影響は限られる。
- Node アダプタ向けに動作確認している。環境変数は `process.env` を優先し、無ければ `virtual:emdash/env` にフォールバックする（Cloudflare Workers での動作は未検証）。
- ネイティブプラグインとして EmDash の内部 API（`OptionsRepository`、`AuthProviderDescriptor`、`virtual:emdash/auth-providers`）に依存する。EmDash の更新で変わりうるため、ピア依存は 2.0 未満に制限している。
- ギルド一覧は最大 2000 件（200 件 × 10 ページ）まで確認する。それを超えるユーザーは `guild_fetch_failed` で拒否する。
- 脆弱性は [SECURITY.md](./SECURITY.md) の手順（GitHub の Private vulnerability reporting）で非公開に報告すること。

## テスト

```bash
pnpm install
pnpm test    # 単体テスト・ルート（login / callback）のテスト・パッケージ検査のテスト
pnpm check   # 実際に公開されるファイルに対するパッケージ検査
```

- メンテナ向け: 固有名の検査は、任意の外部ファイル `.check-package.private-terms`（gitignore 済み・1行1語。環境変数 `CHECK_PACKAGE_PRIVATE_TERMS_FILE` でも指定可）を使って `pnpm check` が行う。ファイルが無ければこの検査はスキップされる。

ルートのテストは、実物の `@emdash-cms/auth` と、インメモリの DB・セッションで `routes/login.js` と `routes/callback.js` を駆動する。

モック Discord サーバー `emdash-auth-discord/testing/mock-discord`（`test/mock-discord.mjs`）は **テスト専用**。固定シークレットで任意のユーザーのトークンを発行するので、本番では絶対に起動しないこと（`127.0.0.1` にのみ bind し、`NODE_ENV=production` では起動を拒否する）。`node node_modules/emdash-auth-discord/test/mock-discord.mjs`（ポートは環境変数 `PORT`、既定 4400）で起動し、`DISCORD_BASE_URL=http://127.0.0.1:4400` と `DISCORD_CLIENT_SECRET=mock-secret` でアプリを起動する。認可 URL に `as=<a|b|c|d|e>` を付けるとモックのユーザーを選べ、`deny=1` で拒否を再現できる。

`pnpm-workspace.yaml` はこのパッケージを単独で開発するための設定（ピア依存を自動インストールしない）。

## ライセンス

[MIT](./LICENSE)
