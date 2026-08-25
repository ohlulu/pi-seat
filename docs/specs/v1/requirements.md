---
summary: pi-seat v1 requirements — exclusive credential store, session env pin, fail-closed runtime overlay, usage CLI contract
read_when:
  - Implementing or changing any pi-seat store, extension, or CLI behavior
  - Verifying an implementation against acceptance criteria
---

# pi-seat v1 — Requirements

## Summary

把 seat 重寫為 Pi extension + TS CLI 的 monorepo：credential 存放於獨佔 store（不再共享 auth.json），支援 per-session 帳號固定（env pin），並完整保留 seat 的 usage 圖表與命名習慣。

## Requirements

### REQ-001: Exclusive credential store

The system SHALL store named OAuth profiles for `anthropic` and `openai-codex` in an exclusive store file. The system SHALL never mutate `auth.json`, and SHALL never copy an `auth.json` credential into the store. Read-only access to `auth.json` is limited to two enumerated uses: the built-in usage snapshot (REQ-006) and the migration equality comparison (REQ-008); the snapshot content SHALL never be persisted into `seat.json`.

store 路徑：`$PI_CODING_AGENT_DIR/seat.json`（未設 env 時為 `~/.pi/agent/seat.json`），權限 0600，atomic write，cross-process file lock。每個 named profile 持有獨立的 OAuth grant——credential 永不與 auth.json 複製共享，因為 Anthropic refresh token 是 single-use，共享 grant 必然導致 double-spend。

| AC | Given | When | Then |
|---|---|---|---|
| AC-001 | 任一 seat 操作（login/use/rm/rename/usage） | 操作完成 | `auth.json` byte-identical 於操作前（no-write assertion） |
| AC-002 | store 檔不存在 | 首次寫入 | 檔案以 0600 建立；讀取端拒絕 symlink |

### REQ-002: Session-scoped pin via env var

WHEN Pi starts with `PI_SEAT` set, the extension SHALL apply the named profile(s) for that session only, taking precedence over the store's global default.

Selector grammar（所有接受 selector 的指令與 `PI_SEAT` 共用）：

1. Selector 形式為 `[provider:]label-or-alias`；裸值（無 provider prefix）固定指 `anthropic`。
2. 只有 recognized provider prefix（`anthropic:`、`openai-codex:`）視為 qualification；label 與 alias 禁用 `:` 與 `,`（於 login/rename 驗證）。
3. `PI_SEAT` 單一裸值只 pin anthropic；逗號分隔的多值必須全部 provider-qualified，且 provider 不得重複。
4. 未出現在 pin 的 provider 照常走 `store default > Pi built-in`。
5. malformed、unknown provider、duplicate provider、不存在的 label——一律於 session startup 明確報錯並 fail-closed，絕不部分套用。
6. env 只在 extension init 讀一次；alias 於 init 一次解析為 label，之後不重解析。解析後的 profile 若在 session 中被刪除，per-turn 套用時 fail-closed。

| AC | Given | When | Then |
|---|---|---|---|
| AC-003 | 兩個 pi session，`PI_SEAT=work` 與 `PI_SEAT=personal` | 同時運行 | 各自以指定帳號發請求，互不影響，store default 不變 |
| AC-004 | `PI_SEAT=nosuch`（不存在的 label）或 malformed selector | session 啟動 | 該 provider fail-closed（turn 中止並報錯），絕不靜默改用其他帳號 |

### REQ-003: Global default selection

`/seat use <selector>`（及 CLI `seat use <selector>`）SHALL persist the selection as the store's global default in every session, including pinned sessions. WHERE the target provider has an env pin, the command SHALL still persist the default and SHALL report that this session keeps its pin. WHERE neither pin nor default exists for a provider, Pi's built-in login SHALL be used untouched.

保留 seat shorthand：`/seat <selector>`、`seat <selector>` 等同 `use`。選 `default` 即清除該 provider 的 global default，還原 Pi 內建登入。

| AC | Given | When | Then |
|---|---|---|---|
| AC-005 | 無 pin 的 session | `/seat use work` | store default 更新；本 session 與之後所有無 pin session 生效 |
| AC-006 | provider 無 default 無 pin | 任何 turn | Pi 內建登入原樣運作，runtime 無 seat override |
| AC-016 | 有 pin 的 session | `/seat use other` | store default 更新；本 session 仍使用 pin；顯示「default 已更新，本 session 維持 pin」提示 |
| AC-017 | profile `ohlulu` 存在，無 alias `o` | `/seat ohlulu -a o` | default 指向 ohlulu；alias `o` 指向 ohlulu；後續 `/seat o` 生效 |

### REQ-004: Fail-closed runtime application

The extension SHALL apply the selected credential as a runtime provider overlay on every turn, following the sequence refresh → toAuth → apply → verify. IF any step fails — including sentinel installation itself — the extension SHALL abort that provider's turn first, then best-effort install a non-secret sentinel key. Abort SHALL never depend on the sentinel succeeding.

fail-closed 狀態只存在記憶體，不落盤：暫時性失敗（網路抖動）下一個 turn 自動重試復原；持久性失敗（refresh token 死亡）持續擋住直到重新 login。其他 provider 不受影響。

| AC | Given | When | Then |
|---|---|---|---|
| AC-007 | refresh 失敗（模擬 invalid_grant） | turn 開始 | turn 中止並顯示原因；store 內 credential 未被刪除 |
| AC-008 | overlay 流程任一步 throw（含 sentinel 安裝自身） | turn 開始 | turn 先被 abort，provider request 零次發出 |

### REQ-005: Single-flight refresh

All token refreshes — from the extension or the CLI — SHALL go through a locked store update: acquire lock, re-read, refresh only if still expired, write back, release. The system SHALL never issue two concurrent refresh requests for the same grant.

Lost-response semantics：refresh 已 dispatch 但 response 遺失（timeout、crash）視為暫時性失敗，store 保留舊 credential；下一次嘗試重送同一 token。若 server 端已 commit rotation，重送得到 `invalid_grant`，流入 REQ-004 的持久性 fail-closed，需重新 login。rotated token 從未被本地收到，此路徑下 grant 本已不可恢復——重送不會損害任何仍持有的 credential。

| AC | Given | When | Then |
|---|---|---|---|
| AC-009 | 兩個 OS process 同時對同一過期 credential 觸發 refresh | 並發執行 | OAuth refresh endpoint 只被呼叫一次；兩邊最終讀到同一顆 rotated credential |

### REQ-006: Usage meters in the CLI

The `seat` CLI（TS，bun runtime）SHALL render usage bars for every stored profile, Pi's built-in login credential, and Codex, preserving the Python seat visual contract: 5h/weekly bars、layout tiers（依終端寬度退讓）、CJK cell width、spinner、JSON 輸出。

CLI synopsis 與 I/O 契約（與 Python 版一致）：

| Command | 行為 |
|---|---|
| `seat` | usage（預設） |
| `seat usage [--json]` | usage；`--json` 掛在 `usage` 子指令 |
| `seat status [--plain]` | 狀態；`--plain` 輸出 TSV |
| `seat whoami [--plain]` | 離線：報告 store default 與（pi session 內）當前 pin |
| `seat use <selector> [-a\|--alias <alias>]…` / `seat <selector> [-a …]` | 寫 global default（shorthand 同義）；`-a` 同時把 alias 指向目標 profile（沿用 Python seat 的 use 語意） |
| `seat login <selector> [-a\|--alias <alias>]…` | named login，alias repeatable |
| `seat rm <selector> [--force\|--no-input]` | 刪除 profile |
| `seat rename <old-selector> <new-label>` | 改名；old selector 決定 provider |

Primary output 只走 stdout；diagnostics 與 prompts 只走 stderr。Exit codes：0 成功、1 operation failure、2 usage error。

`seat status --plain` 契約：Anthropic-only、每列恰四個 tab-separated 欄位、無 header；`active` 表示本 process 的有效 Anthropic named selection（pin 優先於 default）；built-in login 時無 active row。Provider-aware 狀態由 human-readable status 與 `--json` 提供。

The CLI MAY refresh an expired stored credential on demand through the REQ-005 path — dormant profile 的 usage 不再因 access token 過期而缺席。auth.json 的內建登入 credential 過期時，CLI SHALL NOT refresh it（那是 Pi 的 grant），僅提示。

| AC | Given | When | Then |
|---|---|---|---|
| AC-010 | 一個 dormant profile 的 access token 已過期 | `seat` | 該 profile 先被 refresh（走 lock），bar 正常渲染 |
| AC-011a | 終端寬度 2–200 掃描 | 渲染任何畫面 | 每列不溢出，且與 Python golden fixtures 完全一致 |
| AC-011b | 終端寬度 ≥ 40 | 渲染任何畫面 | account name、meter label、percent 必須保留；截斷帶 ellipsis |

### REQ-007: Named login replaces `save`

`/seat login <selector>` SHALL mint a new OAuth grant through the provider's own login flow and store it under the label. The `save` command（捕捉 auth.json 現有 credential）is retired：在獨佔 store 架構下，捕捉共享 grant 正是必須禁止的操作。

保留 alias 習慣：`-a <alias>` repeatable；`rm`、`rename`、alias resolution 語意與 Python seat 相同。

| AC | Given | When | Then |
|---|---|---|---|
| AC-012 | `/seat login work` 完成 OAuth | 登入成功 | store 新增 work profile；auth.json 未變 |
| AC-013 | label 與既有 profile 重名 | login | 確認後才覆蓋（destructive confirm） |

### REQ-008: Migration from claude-profiles.json

On first load, IF `seat.json` does not exist AND `claude-profiles.json` does, the extension SHALL import legacy profiles with these exclusion rules, and SHALL retain the legacy file untouched for rollback:

1. 無條件排除 legacy `active` label 指向的 profile——Pi refresh 會 rotate token，byte-equality 認不出已 rotated 的 active lineage。
2. 額外排除 refresh token 與 auth.json 當下 anthropic credential 相同的 profile。
3. `active` 欄位缺失、指向不存在的 profile、或比對結果 ambiguous → migration fail-closed，不猜測匯入，提示逐帳號 `/seat login`。

migration 後以訊息告知：被排除的帳號仍以 Pi 內建登入身分可用，要成為 named profile 請跑一次 `/seat login`。

| AC | Given | When | Then |
|---|---|---|---|
| AC-014 | legacy fixture：`active` pointer 與 byte-equality 結果不一致 | extension 首次載入 | 兩條排除規則各自生效；dormant 匯入；active lineage 未匯入；legacy 檔案未動 |

### REQ-009: Codex connection invalidation

WHEN the active openai-codex account changes, the extension SHALL invalidate live Codex WebSocket connections so no request rides a stale credential.

| AC | Given | When | Then |
|---|---|---|---|
| AC-015 | codex 帳號切換 | 切換完成 | 既有 WebSocket 連線被關閉（close 完成後才回報切換成功），下一請求以新 credential 建立 |

### REQ-010: In-session usage view

WHEN `/seat` runs with no arguments, or `/seat status` runs, in a TUI session, the extension SHALL open an interactive usage view rendering the same bars as the CLI (all stored profiles + built-in + Codex) plus the current default/pin state, and SHALL close on `esc` or `q`. WHERE the session is not TUI (`ctx.mode !== "tui"`；RPC、print mode), the command SHALL fall back to text output instead of opening a component.

渲染復用 `src/usage` 純模組；view 開啟期間的 refresh 仍走 REQ-005 路徑。

| AC | Given | When | Then |
|---|---|---|---|
| AC-018 | TUI session | `/seat` 或 `/seat status` | view 開啟並渲染 usage bars 與 default/pin 狀態；`esc` 與 `q` 都關閉 view |
| AC-019 | 非 TUI session（RPC / `pi -p`） | `/seat status` | 文字輸出，不開 component，不 hang |

## Non-functional

- NFR-001: CLI 冷啟至 `--plain` 輸出 process-cold p95 ≤ 150ms（hyperfine 量測，repo 內提供 benchmark command；prompt segment 可用性；bun 執行）。
- NFR-002: 自 pi-accounts（MIT）改作的程式碼保留 attribution（LICENSE / NOTICE）。

## Retired from Python seat (by design)

- `save`（見 REQ-007）。
- Identity attribution（server 端歸屬查詢、`whoami` 的網路路徑）：獨佔 store 下 credential 的 owner 由 login 時的命名決定，無歸屬問題可解。`whoami` 保留為離線指令：報告 store default 與（若在 pi session 內）當前 pin。
- Pi lock 相容邏輯（45s stale window 對 auth.json.lock）：不再碰 auth.json，改為 store 自己的 lock。

## Related

- [plan.md](./plan.md) ← Technical decisions, change map, verification matrix
