# pi-seat

[English](./README.md) | [繁體中文](./README.zh-TW.md) | **日本語** | [Español](./README.es.md) | [Français](./README.fr.md)

[Pi](https://github.com/badlogic/pi-mono) のマルチアカウント管理ツール。Anthropic と OpenAI Codex の OAuth アカウントをセッション単位で切り替え、使用量メーターをターミナルで確認できます。

- **名前付きプロファイル** — `work`、`personal`、`team`… 各プロファイルは専用ストア内に独立した OAuth グラントを保持します。Pi の `auth.json` には一切書き込みません。
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
/seat status            # 使用量・デフォルト・pin — ↑↓ で選択、enter で切り替え、esc/q で閉じる
```

`/seat` と `/seat status` は TUI セッションでは対話的な使用量ビューを開き、それ以外（RPC、`pi -p`）ではテキスト出力にフォールバックします。ビュー内では `↑↓`/`jk` でアカウントを移動し、`enter` でカーソル上のアカウントをそのプロバイダのデフォルトにします。built-in の行を選ぶと、そのプロバイダは Pi 本体のログインに戻ります。

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

## 安全設計

プロファイルは `~/.pi/agent/seat.json`（0600、ファイルロック、アトミック書き込み）に保存されます。各プロファイルは OAuth グラントを専有し、Pi の `auth.json` との間でクレデンシャルを複製することはありません。Anthropic のリフレッシュトークンはシングルユースであり、グラントを共有すると二重消費が必ず発生するためです。トークンのリフレッシュはプロセスをまたいでシングルフライトです。

## ライセンス

MIT。クレデンシャルライフサイクル層は [pi-accounts](https://www.npmjs.com/package/@narumitw/pi-accounts)（MIT）を改変したものです — [NOTICE](./NOTICE) を参照してください。
