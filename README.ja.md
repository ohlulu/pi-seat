# pi-seat

[English](./README.md) | [繁體中文](./README.zh-TW.md) | **日本語** | [Español](./README.es.md) | [Français](./README.fr.md)

[Pi](https://github.com/badlogic/pi-mono) のマルチアカウント管理ツール。Anthropic と OpenAI Codex の OAuth アカウントをセッション単位で切り替え、使用量メーターをターミナルで確認できます。

- **名前付きプロファイル** — `work`、`personal`、`team`… 各プロファイルは専用ストア内に独立した OAuth グラントを保持します。Pi の `auth.json` には一切書き込みません。Anthropic プロファイルには代わりに Console の API キーも保存でき、プラン利用枠と API 課金の切り替えはコマンド一つです。
- **セッション固定** — 環境変数 `PI_SEAT` で、2 つの Pi セッションを別々のアカウントで同時に実行できます。
- **使用量メーター** — 各プロファイルの 5 時間・週間使用量バーを CLI に表示します。バーの色は使用量ではなく消費ペースを表します。現在のペースでリセット前に上限を超える見込みなら赤、際どければ黄、余裕があれば緑です。
- **フェイルクローズド** — クレデンシャルのリフレッシュと検証に失敗した場合、そのプロバイダで実行中のターンを中止します。古い、または誤ったアカウントでリクエストが送られることはなく、死んだプロファイルが他のプロバイダでのターンをブロックすることもありません。

## 必要条件

- [bun](https://bun.sh)
- [Pi](https://github.com/badlogic/pi-mono)（Anthropic または OpenAI Codex の OAuth ログイン済み）

## インストール

```sh
pi install npm:pi-seat    # 拡張 — Pi に /seat を追加
```

インストールはこれだけです。`/seat` はすべてのコマンドをカバーします: `login`、`use`、`rm`、`rename`、`status`、`whoami`、`usage`。

<details>
<summary>任意: seat CLI</summary>

拡張は CLI を一切参照しないため、`/seat` には構造上できないことのためだけに導入します — shell プロンプト用の `--plain` / `--json` 出力と、Pi セッションを起動せずに使用量を見ること。

`pi install` はすでに `~/.pi/agent/npm/node_modules/.bin/seat` に実行可能なバイナリを配置済みで、そのディレクトリが `PATH` にないだけです。`PATH` 上のディレクトリにリンクしてください:

```sh
ln -sf ~/.pi/agent/npm/node_modules/.bin/seat /usr/local/bin/seat
```

`bun add -g pi-seat` でも動作しますが、同じパッケージをもう一度ダウンロードするため、更新すべきインストールが 2 つになります。

</details>

<details>
<summary>ソースからインストールする場合</summary>

```sh
git clone https://github.com/ohlulu/pi-seat.git && cd pi-seat && bun install
```

`~/.pi/agent/settings.json` の `packages` にリポジトリのパスを追加します。任意の CLI を使う場合は、`PATH` 上に `seat` シムを作成します:

```sh
printf '#!/bin/sh\nexec bun /path/to/pi-seat/src/cli/main.ts "$@"\n' > /usr/local/bin/seat
chmod +x /usr/local/bin/seat
```

</details>

## クイックスタート

Pi セッション内で:

```
/seat login work        # OAuth で新しいグラントを作成し "work" として保存
/seat use work          # "work" をグローバルデフォルトに設定
/seat use work -a w     # 同時にエイリアス "w" を割り当て
/seat status            # 使用量・デフォルト・pin — ↑↓ で選択、enter で切り替え、x でリセット、esc/q で閉じる
```

`/seat` と `/seat status` は TUI セッションでは対話的な使用量ビューを開き、それ以外（RPC、`pi -p`）ではテキスト出力にフォールバックします。ビュー内では `↑↓`/`jk` でアカウントを移動し、`enter` でカーソル上のアカウントをそのプロバイダのデフォルトにします。built-in の行を選ぶと、そのプロバイダは Pi 本体のログインに戻ります。`x` はカーソル上のアカウントで保存済みの使用量リセット（Codex のリセットクレジット、または Claude のリミットリセット）を使います。その場で `y`/`n` の確認が表示され、どのリセットか、期限、サーバーが拒否しうる理由が示されます。メーター下の `credits` 行が残り枚数です。

セッションを特定のアカウントに固定（デフォルトより優先、そのセッションのみ）:

```sh
PI_SEAT=work pi         # ラベルのみの場合は anthropic
PI_SEAT="anthropic:work,openai-codex:team" pi
```

シェルから使用量を確認:

```sh
seat                    # 全プロファイルの使用量バー
seat status --plain     # シェルプロンプト向けの TSV 出力
```

`use default` はデフォルトを解除し、Pi 標準のログインに戻します。`rm`、`rename`、繰り返し可能な `-a <alias>`（`login` と `use` の両方）も期待どおりに動作します。

### Anthropic API キー

Anthropic プロファイルには OAuth グラントの代わりに Claude Console の API キーを保存できます。このプロファイルでのリクエストはプランの利用枠ではなく、キーが属する Console 組織に課金されます。Max・Ultra・Team プランに含まれる毎月の API クレジットはここで消費されます（[詳細](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans)）。

```
/seat login console --api-key -a c    # マスク入力。保存前に Anthropic でキーを検証
/seat use c                           # API 課金に切り替え。/seat use work で戻す
```

```sh
seat login console --api-key          # CLI：キーは echo を切った stdin から読み、argv は使わない
PI_SEAT=console pi                    # 1 つのセッションをこのキーに固定
```

`-k` は `--api-key` の短縮形です。キーをコマンドラインに書かないでください。書いた時点でシェルや Pi の入力履歴に残るため、seat はキーのような引数をすべて拒否します。そのキーは失効させ、新しいキーをプロンプトに貼り付けてください。パイプで既存プロファイルのキーを差し替えるには、先に `seat rm` してください。上書きの確認には端末が必要です。

キーが Claude の OAuth トークン（`sk-ant-oat…`）や Admin キーの場合、または Anthropic の検証が成功を返さない場合は保存しません。API キーのプロファイルにはプランのメーターがありません。usage ビューと `seat` には、残高を確認できる Console の請求ページへのクリック可能なリンク付きで表示され（Anthropic には残高を返す API がありません）、`x` で使えるリセットもありません。Pi はこのセッションをサブスクリプションではなく API 課金として表示します。API キーを受け付けるのは `anthropic` だけです。

`~/.pi/agent/models.json` で `anthropic` の `user-agent` ヘッダーを上書きしないでください。このヘッダーは API キーのリクエストにも付き、seat では外せません。値が `claude-cli/…` だと Anthropic はリクエストを Claude Code として課金し、毎月のクレジットの対象外になるため、組織に購入済みクレジットがなければ `Your credit balance is too low` で失敗します。Pi の OAuth リクエストはもともとこの user-agent を送っているので、上書きは OAuth には何の効果もありません。

API キーのプロファイルを含むストアは pi-seat 0.5.0 以前では読み込めません。ダウングレードする前にそのプロファイルを削除してください。

### API キーの使用額

Anthropic には残高を返す API はありませんが、Admin API はキーごとの使用額を返します。API キーのプロファイルに月次サイクルと、そのキーが属する Console organization の Admin key を設定すると、usage view と `seat` は billing リンクの代わりに今のサイクルの使用額を表示します。

```sh
seat since console 11/27/2026         # 2026-11-27 でも可。毎月 27 日に新しいサイクルが始まる
seat admin-key console                # Admin key を echo なしの stdin から読み、保存前に検証
```

```
● console · API key
  spent $23.47 since 2026-11-27
  resets 2026-12-27 · data as of 14:05
```

日付はリセット日を指定するだけで、過去でも未来でも同じ意味です。11/9 に `11/27/2026` を指定すると 10/27〜11/27 を集計します。各サイクルは `since` を実行したマシンのタイムゾーンで 00:00 に始まり、その日がない月は月末日にリセットされます。Admin key は 1 つの Console organization に属するため、API キーのプロファイルごとに設定します。2 つの organization のキーには Admin key が 2 本必要です。Console の Settings → Admin keys で作成してください。Admin API は organization アカウントだけが使え、個人アカウントでは使えません。ほかの認証情報と同じく `seat.json` に保存され、表示されることはなく、organization のキー一覧と使用額の取得にだけ使われます。`seat admin-key console --rm` で削除できます。Anthropic の使用額データは最大 24 時間（通常 4 時間以内）遅れるため、データ時刻を表示します。Pi の中では `/seat since` と `/seat admin-key` が同じ働きをします。

サイクルか Admin key を設定した store は pi-seat 0.6.0 以前では読めません。ダウングレード前に各プロファイルで `seat since <label> --clear` と `seat admin-key <label> --rm` を実行してください。

## 安全設計

プロファイルは `~/.pi/agent/seat.json`（0600、ファイルロック、アトミック書き込み）に保存されます。API キーもここに保存され、表示されることはありません。各 OAuth プロファイルはグラントを専有し、Pi の `auth.json` との間でクレデンシャルを複製することはありません。Anthropic のリフレッシュトークンはシングルユースであり、グラントを共有すると二重消費が必ず発生するためです。トークンのリフレッシュはプロセスをまたいでシングルフライトです。

## ライセンス

MIT。クレデンシャルライフサイクル層は [pi-accounts](https://www.npmjs.com/package/@narumitw/pi-accounts)（MIT）を改変したものです — [NOTICE](./NOTICE) を参照してください。
