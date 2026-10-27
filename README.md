# ゲーマータグ照会(管理者用)

Minecraft統合版のゲーマータグを入力すると、次の3つを表示するCloudflare Pages用のサイトです。

- アカウントが存在するか
- Minecraftの実績・プレイ時間・ゲーマースコアから計算した安全度の目安(0〜100%)
- 機種ごとの記録

Xboxのデータは非公式APIの [OpenXBL](https://xbl.io) から取得します。APIキーはサーバー側(Pages Functions)だけで使うので、ブラウザには渡りません。サイト全体はBasic認証で保護されます。

## ファイル構成

```
public/            画面(index.html / style.css / app.js)
functions/
  _middleware.js   サイト全体のBasic認証
  api/lookup.js    GET /api/lookup?gamertag=... の本体(キャッシュとエラー処理)
lib/
  openxbl.js       OpenXBLの呼び出し
  lookup-core.js   照会の流れ(検索 → プロフィール → 履歴 → プレイ時間 → スコア)
  minecraft.js     履歴からMinecraft(統合版)を拾う処理
  score.js         安全度の計算(重みはここで調整)
test/              ロジックのテスト
scripts/mock-openxbl.mjs  ローカル確認用の偽OpenXBLサーバー
```

## 1. OpenXBLのAPIキーを取る

1. https://xbl.io を開き、MicrosoftアカウントでサインインしてAPIキーを発行します。
2. キーは他人に見せないでください。照会はこのキーの持ち主のアカウントとして行われます。そのため、相手が履歴を「フレンドのみ」に公開していて、そのアカウントとフレンドであれば、その履歴も見えます。

無料枠は1時間あたり約150リクエストです(OpenXBLを使っている別プロジェクトの記載による)。1回の照会で使うのは3〜5リクエストなので、管理者だけで使うなら十分です。

## 2. Cloudflare Pagesに公開する

### A. GitHub連携で公開する(おすすめ)

1. このフォルダをGitHubのリポジトリにpushします(`.dev.vars` は `.gitignore` 済み)。
2. Cloudflareダッシュボードで「Workers & Pages」からPagesのプロジェクトを作成し、Gitに接続してそのリポジトリを指定します。
3. ビルド設定は次のとおりにします。
   - フレームワーク: なし
   - ビルドコマンド: 空欄
   - ビルド出力ディレクトリ: `public`
4. 作成後、プロジェクトの設定にある「Variables and Secrets」(変数とシークレット)で、次の2つを**シークレット**として追加します。プレビュー用URLも使うなら、プレビュー環境にも同じものを入れます(入れなければプレビューは503で止まるだけなので安全です)。
   - `OPENXBL_API_KEY`: 手順1のキー
   - `ADMIN_PASSWORD`: 管理者が入力するパスワード(長めのもの)
5. 再デプロイします。サイトを開くとユーザー名とパスワードを聞かれるので、ユーザー名 `admin` と `ADMIN_PASSWORD` を入力します。

`wrangler.toml` があるリポジトリでは、このファイルに書いた変数(`CACHE_TTL_SECONDS`、`ADMIN_USER`)やKVの設定が優先され、ダッシュボードからは編集できなくなります。変えたいときは `wrangler.toml` を編集してpushしてください。シークレットはこのファイルに書かず、ダッシュボードかコマンドで設定します。

### B. コマンドで公開する

```bash
npm install
npx wrangler login
npx wrangler pages project create mc-gamertag-checker --production-branch main
npx wrangler pages secret put OPENXBL_API_KEY --project-name mc-gamertag-checker
npx wrangler pages secret put ADMIN_PASSWORD --project-name mc-gamertag-checker
npm run deploy
```

## 3. キャッシュを有効にする(任意)

同じゲーマータグを何度も照会してもAPIを使わないよう、結果を1時間保存できます。

```bash
npx wrangler kv namespace create CACHE
```

表示されたIDを `wrangler.toml` 末尾のコメント部分に入れ、コメントを外して再デプロイします。画面の「最新の情報で再取得」を押すと、保存済みの結果を使わずに取り直します。

## 4. アクセス制限について

- `ADMIN_PASSWORD` が未設定のときは、誤って公開しないよう、すべてのアクセスを503で止めます。
- 画面もAPIも、プレビュー用URL(`*.pages.dev` のブランチ別URL)も、同じBasic認証の対象です。
- Cloudflare Access(Zero Trust)で保護する場合だけ、`wrangler.toml` の `[vars]` に `DISABLE_BASIC_AUTH = "true"` を追加します。Accessを設定していない状態でこれを入れると、誰でも見られるようになるので注意してください。
- 検索エンジンに載らないよう、`noindex` を付けています。

## 5. 安全度の計算

| 項目 | 配点 | 満点の目安 |
|---|---|---|
| Minecraftの実績達成率(最も進んでいる機種) | 50 | 全実績を解除 |
| Minecraftのプレイ時間(取得できた機種の合計) | 30 | 100時間 |
| アカウント全体のゲーマースコア | 20 | 10,000 |

- プレイ時間とゲーマースコアは対数の目盛りで換算します(序盤ほど点が伸びやすい)。
- 取得できなかった項目は、残りの項目で配点を按分します。
- Xboxの評判が `NeedsWork` なら×0.7、`AvoidMe` なら×0.4の補正をかけます。
- ゲーム履歴が非公開・空の場合は「判定不能」と表示します。
- 判定は70%以上「高い」、40〜69%「中程度」、39%以下「低い」です。

重み・満点の目安・補正倍率・区切りは、すべて `lib/score.js` の `SCORE_CONFIG` で変えられます。

## 6. 知っておきたい制約

- **非公式API**: OpenXBLの仕様変更や停止で使えなくなる可能性があります。
- **プレイ時間**: APIから取れないアカウントがあります。その場合は「取得できず」と表示し、按分で計算します。
- **機種別の実績**: 統合版の実績は機種ごとに別タイトルとして記録されるので、最も進んでいる機種の達成率を使います。
- **PlayStation版**: 実績はPSN側に記録されるため、Xboxから見ると記録がなく、低く出ます。
- **タイトルの判定**: 確認できたタイトルIDと「名前にMinecraftを含み、DungeonsやLegendsではない」という条件で拾っています。画面の「機種ごとのMinecraftの記録」で、拾われたタイトルを確認できます。漏れがあれば、そのタイトルIDを `wrangler.toml` の `[vars]` に `EXTRA_MINECRAFT_TITLE_IDS = "123,456"` の形で追加してください。
- **あくまで目安**: 新しいアカウントや、履歴を非公開にしている人も低く出ます。参加の可否はこの数値だけで決めないでください。

## 7. ローカルで試す

```bash
npm install
npm test                                  # ロジックのテスト
cp .dev.vars.example .dev.vars            # 値を入れる
npm run dev                               # http://localhost:8788
```

本物のAPIを使わずに画面を確かめたいときは、偽のOpenXBLサーバーを使います。

```bash
node scripts/mock-openxbl.mjs 8790
# .dev.vars を次のようにして npm run dev
# OPENXBL_API_KEY=test-key
# OPENXBL_BASE=http://127.0.0.1:8790/api/v2
# ADMIN_PASSWORD=お好みで
```

偽サーバーでは `TestPlayer`(通常)、`PrivatePlayer`(履歴非公開)、`PsPlayer`(Minecraftの記録なし)、`BadRep`(評判が悪い・プレイ時間取得失敗)、`RateLimited`(上限到達)を照会できます。それ以外の名前は「見つからない」になります。
