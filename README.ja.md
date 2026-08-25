# pi-seat

[English](./README.md) | [繁體中文](./README.zh-TW.md) | **日本語** | [Español](./README.es.md) | [Français](./README.fr.md)

[Pi](https://github.com/badlogic/pi-mono) のマルチアカウント管理ツール。Anthropic と OpenAI Codex の OAuth アカウントをセッション単位で切り替え、使用量メーターをターミナルで確認できます。

- **名前付きプロファイル** — `work`、`personal`、`team`… 各プロファイルは専用ストア内に独立した OAuth グラントを保持します。Pi の `auth.json` には一切書き込みません。
- **セッション固定** — 環境変数 `PI_SEAT` で、2 つの Pi セッションを別々のアカウントで同時に実行できます。
- **使用量メーター** — 各プロファイルの 5 時間・週間使用量バーを CLI に表示します。
- **フェイルクローズド** — クレデンシャルのリフレッシュと検証に失敗した場合、そのターンを中止します。古い、または誤ったアカウントでリクエストが送られることはありません。

## 必要条件

- [bun](https://bun.sh)
- [Pi](https://github.com/badlogic/pi-mono)（Anthropic または OpenAI Codex の OAuth ログイン済み）

## インストール

```sh
git clone https://github.com/ohlulu/pi-seat.git
cd pi-seat && bun install
```

`~/.pi/agent/settings.json` の `packages` にリポジトリのパスを追加して拡張を登録します:

```json
{ "packages": ["/path/to/pi-seat"] }
```

`PATH` 上に `seat` CLI シムを作成します:

```sh
printf '#!/bin/sh\nexec bun /path/to/pi-seat/src/cli/main.ts "$@"\n' > ~/.pi/agent/bin/seat
chmod +x ~/.pi/agent/bin/seat
```

## クイックスタート

Pi セッション内で:

```
/seat login work        # OAuth で新しいグラントを作成し "work" として保存
/seat use work          # "work" をグローバルデフォルトに設定
/seat status            # 現在有効なアカウントを確認
```

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

`use default` はデフォルトを解除し、Pi 標準のログインに戻します。`rm`、`rename`、繰り返し可能な `-a <alias>` も期待どおりに動作します。

## 安全設計

プロファイルは `~/.pi/agent/seat.json`（0600、ファイルロック、アトミック書き込み）に保存されます。各プロファイルは OAuth グラントを専有し、Pi の `auth.json` との間でクレデンシャルを複製することはありません。Anthropic のリフレッシュトークンはシングルユースであり、グラントを共有すると二重消費が必ず発生するためです。トークンのリフレッシュはプロセスをまたいでシングルフライトです。

## ライセンス

MIT。クレデンシャルライフサイクル層は [pi-accounts](https://www.npmjs.com/package/@narumitw/pi-accounts)（MIT）を改変したものです — [NOTICE](./NOTICE) を参照してください。
