# pi-seat

[English](./README.md) | **繁體中文** | [日本語](./README.ja.md) | [Español](./README.es.md) | [Français](./README.fr.md)

[Pi](https://github.com/badlogic/pi-mono) 的多帳號管理工具——每個 session 可獨立切換 Anthropic 與 OpenAI Codex 的 OAuth 帳號，並在終端機直接看用量。

- **命名 profile** — `work`、`personal`、`team`…每個 profile 持有獨立的 OAuth grant，存放在獨佔 store，永不寫入 Pi 的 `auth.json`。
- **Session pin** — 透過 `PI_SEAT` 環境變數，同時開兩個 Pi session 各用不同帳號。
- **用量圖表** — 每個 profile 的 5 小時與每週用量 bar，CLI 直接呈現。
- **Fail-closed** — credential 無法 refresh 並驗證時直接中止該 turn，絕不讓請求騎在過期或錯誤的帳號上。

## 需求

- [bun](https://bun.sh)
- [Pi](https://github.com/badlogic/pi-mono)，並已用 Anthropic 或 OpenAI Codex OAuth 登入

## 安裝

```sh
pi install npm:pi-seat    # extension — 在 Pi 裡加入 /seat
```

這就是完整安裝。`/seat` 涵蓋所有指令：`login`、`use`、`rm`、`rename`、`status`、`whoami`、`usage`。

<details>
<summary>選配：seat CLI</summary>

Extension 完全不依賴 CLI，所以只有需要 `/seat` 結構上做不到的事情時才裝——`--plain` / `--json` 輸出（給 shell prompt segment 用），以及不開 Pi session 就看額度。

`pi install` 已經在 `~/.pi/agent/npm/node_modules/.bin/seat` 放了一個可用的執行檔，只是那個目錄不在 `PATH` 上。把它 link 到 `PATH` 上的目錄即可：

```sh
ln -sf ~/.pi/agent/npm/node_modules/.bin/seat /usr/local/bin/seat
```

`bun add -g pi-seat` 也可以，但它會把同一個套件再下載一份，之後你有兩份安裝要各自更新。

</details>

<details>
<summary>或從原始碼安裝</summary>

```sh
git clone https://github.com/ohlulu/pi-seat.git && cd pi-seat && bun install
```

把 repo 路徑加進 `~/.pi/agent/settings.json` 的 `packages`。選配的 CLI 則在 `PATH` 上建立 `seat` shim：

```sh
printf '#!/bin/sh\nexec bun /path/to/pi-seat/src/cli/main.ts "$@"\n' > /usr/local/bin/seat
chmod +x /usr/local/bin/seat
```

</details>

## 快速上手

在 Pi session 內：

```
/seat login work        # 走 OAuth 建立新 grant，存為 "work"
/seat use work          # 把 "work" 設為全域預設
/seat use work -a w     # 順便把別名 "w" 指到它
/seat status            # 用量、預設與 pin — ↑↓ 選取、enter 切換、esc/q 關閉
```

`/seat` 與 `/seat status` 在 TUI session 會開互動式用量畫面；非 TUI（RPC、`pi -p`）則退回純文字輸出。畫面中用 `↑↓`/`jk` 在帳號間移動，`enter` 把游標所在的帳號設為該 provider 的 default；選到 built-in 那列則是把該 provider 交還給 Pi 內建登入。

把某個 session 固定在特定帳號（優先於預設，只影響該 session）：

```sh
PI_SEAT=work pi         # 裸 label 指 anthropic
PI_SEAT="anthropic:work,openai-codex:team" pi
```

從 shell 查用量：

```sh
seat                    # 所有 profile 的用量 bar
seat status --plain     # TSV 輸出，供 shell prompt 使用
```

`use default` 清除預設、還原 Pi 內建登入。`rm`、`rename` 與可重複的 `-a <alias>`（`login` 和 `use` 都支援）語意如你所料。

## 安全設計

Profile 存於 `~/.pi/agent/seat.json`（0600、file lock、atomic write）。每個 profile 獨佔一份 OAuth grant——credential 永不與 Pi 的 `auth.json` 互相複製，因為 Anthropic refresh token 是 single-use，共享 grant 必然導致 double-spend。跨 process 的 token refresh 為 single-flight。

## License

MIT。credential lifecycle 層改作自 [pi-accounts](https://www.npmjs.com/package/@narumitw/pi-accounts)（MIT）——見 [NOTICE](./NOTICE)。
