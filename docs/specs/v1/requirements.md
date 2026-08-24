# pi-seat v1 — Requirements

## Summary

把 seat 重寫為 Pi extension + TS CLI 的 monorepo：credential 存放於獨佔 store（不再共享 auth.json），支援 per-session 帳號固定（env pin），並完整保留 seat 的 usage 圖表與命名習慣。

## Requirements

### REQ-001: Exclusive credential store

The system SHALL store named OAuth profiles for `anthropic` and `openai-codex` in an exclusive store file, and SHALL never read or write Pi's `auth.json`.

store 路徑：`$PI_CODING_AGENT_DIR/seat.json`（未設 env 時為 `~/.pi/agent/seat.json`），權限 0600，atomic write，cross-process file lock。每個 named profile 持有獨立的 OAuth grant——credential 永不與 auth.json 複製共享，因為 Anthropic refresh token 是 single-use，共享 grant 必然導致 double-spend。

| AC | Given | When | Then |
|---|---|---|---|
| AC-001 | 任一 seat 操作（login/use/rm/rename/usage） | 操作完成 | `auth.json` byte-identical 於操作前 |
| AC-002 | store 檔不存在 | 首次寫入 | 檔案以 0600 建立；讀取端拒絕 symlink |

### REQ-002: Session-scoped pin via env var

WHEN Pi starts with `PI_SEAT` set, the extension SHALL apply the named profile(s) for that session only, taking precedence over the store's global default.

語法：`PI_SEAT=work` 裸 label 指 anthropic（沿用 seat 的 anthropic 中心習慣）；`PI_SEAT="anthropic:work,openai-codex:team"` 為 provider-qualified 完整形。alias 可用於 label 位置。

| AC | Given | When | Then |
|---|---|---|---|
| AC-003 | 兩個 pi session，`PI_SEAT=work` 與 `PI_SEAT=personal` | 同時運行 | 各自以指定帳號發請求，互不影響，store default 不變 |
| AC-004 | `PI_SEAT=nosuch`（不存在的 label） | session 啟動 | 該 provider fail-closed（turn 中止並報錯），絕不靜默改用其他帳號 |

### REQ-003: Global default selection

`/seat use <label>`（及 CLI `seat use <label>`）SHALL persist the selection as the store's global default. WHERE a session has an env pin, the pin SHALL remain in effect regardless of default changes. WHERE neither pin nor default exists for a provider, Pi's built-in login SHALL be used untouched.

保留 seat shorthand：`/seat <label>`、`seat <label>` 等同 `use`。選 `default` 即清除該 provider 的 global default，還原 Pi 內建登入。

| AC | Given | When | Then |
|---|---|---|---|
| AC-005 | 無 pin 的 session | `/seat use work` | store default 更新；本 session 與之後所有無 pin session 生效 |
| AC-006 | provider 無 default 無 pin | 任何 turn | Pi 內建登入原樣運作，runtime 無 seat override |

### REQ-004: Fail-closed runtime application

The extension SHALL apply the selected credential as a runtime provider overlay before each turn, following the sequence refresh → toAuth → apply → verify. IF any step fails, THEN the extension SHALL install a non-secret sentinel key and abort that provider's turns.

fail-closed 狀態只存在記憶體，不落盤：暫時性失敗（網路抖動）下一個 turn 自動重試復原；持久性失敗（refresh token 死亡）持續擋住直到重新 login。其他 provider 不受影響。

| AC | Given | When | Then |
|---|---|---|---|
| AC-007 | refresh 失敗（模擬 invalid_grant） | turn 開始 | turn 中止並顯示原因；store 內 credential 未被刪除 |
| AC-008 | overlay 套用後 verify 不符 | turn 開始 | fail-closed，不以部分套用狀態發請求 |

### REQ-005: Single-flight refresh

All token refreshes — from the extension or the CLI — SHALL go through a locked store update: acquire lock, re-read, refresh only if still expired, write back, release. The system SHALL never issue two refresh requests for the same grant.

| AC | Given | When | Then |
|---|---|---|---|
| AC-009 | 兩個 process 同時對同一過期 credential 觸發 refresh | 並發執行 | OAuth refresh endpoint 只被呼叫一次；兩邊最終讀到同一顆 rotated credential |

### REQ-006: Usage meters in the CLI

The `seat` CLI（TS，bun runtime）SHALL render usage bars for every stored profile, Pi's built-in login credential, and Codex, preserving the Python seat visual contract: 5h/weekly bars、layout tiers（依終端寬度退讓）、CJK cell width、spinner、`--json` 輸出。`seat status --plain` TSV 契約不變（供 shell prompt segment）。

The CLI MAY refresh an expired stored credential on demand through the REQ-005 path — dormant profile 的 usage 不再因 access token 過期而缺席。auth.json 的內建登入 credential 過期時，CLI SHALL NOT refresh it（那是 Pi 的 grant），僅提示。

| AC | Given | When | Then |
|---|---|---|---|
| AC-010 | 一個 dormant profile 的 access token 已過期 | `seat` | 該 profile 先被 refresh（走 lock），bar 正常渲染 |
| AC-011 | 終端寬度 2–200 掃描 | 渲染任何畫面 | 無 row 溢出、無字串靜默消失（golden 對照 Python 版行為） |

### REQ-007: Named login replaces `save`

`/seat login <label>` SHALL mint a new OAuth grant through the provider's own login flow and store it under the label. The `save` command（捕捉 auth.json 現有 credential）is retired：在獨佔 store 架構下，捕捉共享 grant 正是必須禁止的操作。

保留 alias 習慣：`-a <alias>` repeatable；`rm`、`rename`、alias resolution 語意與 Python seat 相同。

| AC | Given | When | Then |
|---|---|---|---|
| AC-012 | `/seat login work` 完成 OAuth | 登入成功 | store 新增 work profile；auth.json 未變 |
| AC-013 | label 與既有 profile 重名 | login | 確認後才覆蓋（destructive confirm） |

### REQ-008: Migration from claude-profiles.json

On first load, IF `seat.json` does not exist AND `claude-profiles.json` does, the extension SHALL import every profile whose credential is NOT byte-identical to auth.json's current anthropic credential, and SHALL retain the legacy file untouched for rollback.

排除 active credential 的原因：它與 auth.json 共享同一顆 grant，匯入即製造 double-refresh。migration 後以訊息告知：該帳號仍以 Pi 內建登入身分可用，要成為 named profile 請跑一次 `/seat login`。

| AC | Given | When | Then |
|---|---|---|---|
| AC-014 | 現有 claude-profiles.json（2 profiles，1 active） | extension 首次載入 | dormant profile 匯入；active 未匯入；legacy 檔案未動 |

### REQ-009: Codex connection invalidation

WHEN the active openai-codex account changes, the extension SHALL invalidate live Codex WebSocket connections so no request rides a stale credential.

| AC | Given | When | Then |
|---|---|---|---|
| AC-015 | codex 帳號切換 | 切換完成 | 既有 WebSocket 連線被關閉，下一請求以新 credential 建立 |

## Non-functional

- NFR-001: CLI 冷啟至 `--plain` 輸出 ≤ 150ms（prompt segment 可用性；bun 執行）。
- NFR-002: 自 pi-accounts（MIT）改作的程式碼保留 attribution（LICENSE / NOTICE）。

## Retired from Python seat (by design)

- `save`（見 REQ-007）。
- Identity attribution（server 端歸屬查詢、`whoami` 的網路路徑）：獨佔 store 下 credential 的 owner 由 login 時的命名決定，無歸屬問題可解。`whoami` 保留為離線指令：報告 store default 與（若在 pi session 內）當前 pin。
- Pi lock 相容邏輯（45s stale window 對 auth.json.lock）：不再碰 auth.json，改為 store 自己的 lock。
