---
summary: pi-seat behavior contract — exclusive credential store, session env pin, fail-closed runtime overlay, usage CLI and in-session view; REQ/AC ids are the stable anchors cited by src and test
read_when:
  - Implementing or changing any pi-seat store, extension, or CLI behavior
  - Resolving a REQ-### or AC-### id cited in code, tests, or scripts
---

# pi-seat — Behavior

## Summary

pi-seat 是 Pi extension + TS CLI 的 monorepo：credential 存放於獨佔 store（不共享 `auth.json`），支援 per-session 帳號固定（env pin），並保留 seat 的 usage 圖表與命名習慣。

Id policy：`REQ-###` 與 `AC-###` 是被 `src/`、`test/`、`scripts/` 直接引用的 stable anchors — append-only，永不 renumber、永不改指涉。技術決策（`DEC-###`）在 [architecture.md §Decisions](../architecture.md#decisions)。

## Store

### REQ-001: Exclusive credential store

The system SHALL store named OAuth profiles for `anthropic` and `openai-codex` in an exclusive store file. The system SHALL never mutate `auth.json`, and SHALL never copy an `auth.json` credential into the store. Read-only access to `auth.json` is limited to exactly one enumerated use: the built-in usage snapshot ([REQ-006](#req-006-usage-meters-in-the-cli)); the snapshot content SHALL never be persisted into `seat.json`.

store 路徑：`$PI_CODING_AGENT_DIR/seat.json`（未設 env 時為 `~/.pi/agent/seat.json`），權限 0600，atomic write，cross-process file lock。每個 named profile 持有獨立的 OAuth grant——credential 永不與 auth.json 複製共享，因為 Anthropic refresh token 是 single-use，共享 grant 必然導致 double-spend。

| AC | Given | When | Then |
|---|---|---|---|
| AC-001 | 任一 seat 操作（login/use/rm/rename/usage） | 操作完成 | `auth.json` byte-identical 於操作前（no-write assertion） |
| AC-002 | store 檔不存在 | 首次寫入 | 檔案以 0600 建立；讀取端拒絕 symlink |

### REQ-005: Single-flight refresh

All token refreshes — from the extension or the CLI — SHALL go through a locked store update: acquire lock, re-read, refresh only if still expired, write back, release. The system SHALL never issue two concurrent refresh requests for the same grant.

Lost-response semantics：refresh 已 dispatch 但 response 遺失（timeout、crash）視為暫時性失敗，store 保留舊 credential；下一次嘗試重送同一 token。若 server 端已 commit rotation，重送得到 `invalid_grant`，流入 [REQ-004](#req-004-fail-closed-runtime-application) 的持久性 fail-closed，需重新 login。rotated token 從未被本地收到，此路徑下 grant 本已不可恢復——重送不會損害任何仍持有的 credential。（審查時提出的持久化 `refreshing` 狀態機被論證為同終態且多出誤鎖路徑，否決。）

| AC | Given | When | Then |
|---|---|---|---|
| AC-009 | 兩個 OS process 同時對同一過期 credential 觸發 refresh | 並發執行 | OAuth refresh endpoint 只被呼叫一次；兩邊最終讀到同一顆 rotated credential |

### REQ-007: Named login

`/seat login <selector>` SHALL mint a new OAuth grant through the provider's own login flow and store it under the label. Capturing an existing `auth.json` credential into the store is forbidden：在獨佔 store 架構下，捕捉共享 grant 正是必須禁止的操作（見 [§Retired](#retired) 的 `save`）。

保留 alias 習慣：`-a <alias>` repeatable；`rm`、`rename`、alias resolution 語意與 Python seat 相同。

Login 互動對齊 Pi 內建 `/login` 體驗：WHEN the provider flow yields an auth URL or device code, the extension SHALL attempt to open the system browser (best-effort, never fatal) and SHALL render the URL as a clickable (OSC 8) link; completion SHALL be reported with an explicit success or failure notification naming the stored label.

成功通知 SHALL state success in words（`login success`）。`ctx.ui.notify(…, "info")` 在 TUI 渲染成一行 dim 小字，與登入過程中的 progress 通知外觀相同，文字本身是區別它們的唯一手段。CLI 的 stderr 訊息用同一句型。

| AC | Given | When | Then |
|---|---|---|---|
| AC-012 | `/seat login work` 完成 OAuth | 登入成功 | store 新增 work profile；auth.json 未變 |
| AC-013 | label 與既有 profile 重名 | login | 確認後才覆蓋（destructive confirm） |
| AC-021 | login flow 發出 auth_url / device_code 事件 | 事件抵達 | browser opener 被呼叫恰一次（失敗不中斷 flow）；notify 含可點擊 URL；完成時有具名 success/failure 訊息 |

## Selection & runtime

### REQ-002: Session-scoped pin via env var

WHEN Pi starts with `PI_SEAT` set, the extension SHALL apply the named profile(s) for that session only, taking precedence over the store's global default.

Selector grammar（所有接受 selector 的指令與 `PI_SEAT` 共用）：

1. Selector 形式為 `[provider:]label-or-alias`；裸值（無 provider prefix）固定指 `anthropic`。
2. 只有 recognized provider prefix（`anthropic:`、`openai-codex:`）視為 qualification；label 與 alias 禁用 `:` 與 `,`（於 login/rename 驗證）。
3. `PI_SEAT` 單一裸值只 pin anthropic；逗號分隔的多值必須全部 provider-qualified，且 provider 不得重複。
4. 未出現在 pin 的 provider 照常走 `store default > Pi built-in`。
5. malformed、unknown provider、duplicate provider、不存在的 label——一律於 session startup 明確報錯並 fail-closed，絕不部分套用。
6. env 只在 extension init 讀一次；alias 於 init 一次解析為 label，之後不重解析。解析後的 profile 若在 session 中被刪除，per-turn 套用時 fail-closed。

Pin badge（AC-026）：WHEN the session has at least one pin, the extension SHALL show a persistent pin badge via Pi's keyed footer status（`ctx.ui.setStatus`，key `pi-seat`，每次 `session_start` 重設，因 `/reload` 會清空 extension statuses；`hasUI` 為 false 的 print/json 模式不設）。槽位固定依 `PROVIDER_IDS` 順序：`:ula:`（anthropic-only）、`:/work:`（codex-only，前導 `/` 標示 anthropic 槽位空缺）、`:ula/work:`（雙 pin）；內容是 resolved canonical label，不是 alias。`/` 是槽位分隔符但同時是合法 label 字元（`isValidLabel` 只禁 `:` 與 `,`），所以 label 內的 `/` 與 `\` SHALL be escaped — 否則 anthropic-only 的 `a/b` 會與 `a` + `b` 雙 pin 的 badge 完全同形。無 pin 的 session 不產生任何 seat chrome。

Startup 失敗 SHALL 顯示 error badge 而非留白 — 此時每個 turn 都被 abort，空 footer 會誤讀為正常的 unpinned session。兩種失敗分開報告，因為修法不同：`PI_SEAT` 本身無效（rule 5）顯示 `PI_SEAT invalid`（在環境變數修），store 讀取或 decode 失敗顯示 `seat store error`（在磁碟上修）；startup notice 的措辭同樣分開，不得把壞掉的 `seat.json` 說成 `PI_SEAT` 的問題。Per-turn fail-closed（[REQ-004](#req-004-fail-closed-runtime-application)）不進 badge：那是 transient per-provider health，不是 session 的 pin identity。

Extension 載入對 store 的保證（AC-020）：載入永不建立 `seat.json`、永不改變 credential 內容、也永不執行任何 legacy 匯入——這條規則是 load-time 匯入專屬測試得以刪除的依據，由 `scripts/smoke-extension.sh` 對 store 缺席與 store 既存兩種情境斷言。載入不是字面上 side-effect-free：init 經由 store 的 read path 解析 pin，該路徑會短暫取得 file lock，並把既有檔案的 mode 重新收斂到 0600（刻意的 defense in depth——每次讀取都把持有 OAuth credential 的檔案硬化回 0600）。

| AC | Given | When | Then |
|---|---|---|---|
| AC-003 | 兩個 pi session，`PI_SEAT=work` 與 `PI_SEAT=personal` | 同時運行 | 各自以指定帳號發請求，互不影響，store default 不變 |
| AC-004 | `PI_SEAT=nosuch`（不存在的 label）或 malformed selector | session 啟動 | 該 provider fail-closed（turn 中止並報錯），絕不靜默改用其他帳號 |
| AC-020 | 任意環境（store 檔與相鄰檔案存在與否皆同） | extension 載入 | `seat.json` 不被建立；既有 store 的內容 byte-identical；無任何匯入。允許的 side effects 僅限 read path 的 transient lock 與 0600 mode 硬化 |
| AC-026 | `PI_SEAT` 分別為 `ula`、`openai-codex:work`、`anthropic:ula,openai-codex:work`、未設、invalid，以及 store 損壞 | session start（含 `/reload` 重入） | footer status 分別為 `:ula:`、`:/work:`、`:ula/work:`、無 badge、error 樣式的 `PI_SEAT invalid`、error 樣式的 `seat store error`；badge 一律顯示 resolved label 而非 alias；label 內的 `/` escape 後與雙 pin badge 不同形；`hasUI` 為 false 時不呼叫 `setStatus`；turn 的成敗不改變 badge |

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

### REQ-009: Codex connection invalidation

WHEN the active openai-codex account changes, the extension SHALL invalidate live Codex WebSocket connections so no request rides a stale credential.

| AC | Given | When | Then |
|---|---|---|---|
| AC-015 | codex 帳號切換 | 切換完成 | 既有 WebSocket 連線被關閉（close 完成後才回報切換成功），下一請求以新 credential 建立 |

## Usage

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

Report structure（human-readable usage 專用；`--json` 是機器契約，不帶任何 chrome）：帳號 SHALL be grouped into one section per provider, in `PROVIDER_IDS` order。每個 section 由一列 header（`ANTHROPIC · <effective selection>`）與一列 rule 開頭，header 使用與 `seat status` 相同的 selection 措辭（`<label> (pin|default)` 或 `Pi built-in login`）。Section SHALL be emitted for every provider, including one with no account to meter — 選擇狀態本身就是該 section 要傳達的資訊。Section 內，該 provider 的 effective selection SHALL be the first account；其餘帳號維持 store 順序，built-in snapshot 殿後。

The CLI MAY refresh an expired stored credential on demand through the [REQ-005](#req-005-single-flight-refresh) path — dormant profile 的 usage 不再因 access token 過期而缺席。auth.json 的內建登入 credential 過期時，CLI SHALL NOT refresh it（那是 Pi 的 grant），僅提示。

| AC | Given | When | Then |
|---|---|---|---|
| AC-010 | 一個 dormant profile 的 access token 已過期 | `seat` | 該 profile 先被 refresh（走 lock），bar 正常渲染 |
| AC-011a | 終端寬度 2–200 掃描 | 渲染任何畫面 | 每列不溢出，且與 Python golden fixtures 完全一致 |
| AC-011b | 終端寬度 ≥ 40 | 渲染任何畫面 | account name、meter label、percent 必須保留；截斷帶 ellipsis |
| AC-022 | 兩個 provider 各有 profile，anthropic 有 pin、codex 有 default，且 active 不是 store 的第一顆 | `seat` 或 `/seat` | 兩個 section header 依序出現並各自報出 effective selection；每個 section 的第一個帳號就是它的 effective selection；無帳號可測的 provider 仍然有 header；`--json` 輸出不含 section chrome |

### REQ-010: In-session usage view

WHEN `/seat` runs with no arguments, or `/seat status` or `/seat usage` runs, in a TUI session, the extension SHALL open an interactive usage view rendering the same bars as the CLI (all stored profiles + built-in + Codex) plus the current default/pin state, and SHALL close on `esc` or `q`. WHERE the session is not TUI (`ctx.mode !== "tui"`；RPC、print mode), the command SHALL fall back to text output instead of opening a component.

渲染復用 `src/usage` 純模組，含 [REQ-006](#req-006-usage-meters-in-the-cli) 的 report structure——default/pin 狀態就是每個 section header 的內容，不另立頂部 header。Section 是 store snapshot 的純函數，所以 header 在第一幀就到位，不等最慢的帳號。View 開啟期間的 refresh 仍走 [REQ-005](#req-005-single-flight-refresh) 路徑。

The view SHALL let the user move a selection between accounts with `↑`/`↓` (and `k`/`j`) and apply the highlighted account with `enter`, which is exactly [REQ-003](#req-003-global-default-selection)'s `use`：帳號列對應 `use <provider>:<label>`，built-in 列對應 `use <provider>:default`（清除該 provider 的 default，還給 Pi 內建登入）。選取是 clamped（不繞回），涵蓋整個帳號區塊而非單一列，並在 refresh 後跟隨同一個帳號。

Switching from the view SHALL NOT refetch usage——liveness 是 store 的事實，不是計量結果的事實；重讀 store 就足以讓點移位。Walk order SHALL NOT be re-sorted in place（重排會把區塊從游標底下抽走），下一次 refresh 或重開才收斂。WHERE the target provider has an env pin, the view SHALL show [AC-016](#req-003-global-default-selection) 的 pin notice inline——pin 不可變，點不會動，那列文字是使用者唯一的回饋。

Key recognition SHALL go through pi-tui's `matchesKey`, never through literal escape-sequence comparison：Pi 協商 Kitty keyboard protocol（見 [architecture.md §DEC-010](../architecture.md#dec-010-key-辨識一律走-pi-tui-的-matcheskey)），協商成功的終端上 esc 與 enter 以 CSI-u 抵達。游標 SHALL always point at an existing account，包含 walk 中途抛錯、帳號清單變短的情況。

Destructive operations (`rm`, `login`) SHALL NOT be reachable from the view：它們需要巳狀對話框，而巳狀 `ctx.ui.custom()` 漏帶 `{ overlay: true }` 會讓 base component 的 promise 永不 resolve（見 `pi.md` extension gotchas）。`use` 非破壞性且可逆，不需確認。

| AC | Given | When | Then |
|---|---|---|---|
| AC-018 | TUI session | `/seat`、`/seat status` 或 `/seat usage` | view 開啟並渲染 usage bars，default/pin 狀態出現在對應 provider 的 section header；`esc` 與 `q` 都關閉 view |
| AC-019 | 非 TUI session（RPC / `pi -p`） | `/seat status` | 文字輸出，不開 component，不 hang |
| AC-023 | view 已載入，provider 有多個帳號 | `↓` 移到另一個帳號後按 `enter` | store default 更新為該帳號；section header 與 live dot 隨之更新；**零新增 usage 請求**；區塊不改排序。Pinned session：default 寫入但點不動，並顯示 pin notice |
| AC-024 | 終端已協商 Kitty keyboard protocol（esc = `esc [ 27 u`、enter = `esc [ 13 u`） | 按下 esc / enter / ↑ / ↓ | 與 legacy encoding 行為完全相同。方向鍵不得被讀成 close |
| AC-025 | reload 已串流出部分帳號後抛錯（例：auth.json 不是 regular file） | view 重畫 | 游標仍指向存活的帳號（同一帳號優先，否則 clamp）；marker 不得消失，`enter` 不得静默無效 |

### REQ-011: Pace-coloured meters

A meter's bar and percent SHALL be coloured by its **burn rate** rather than its absolute level wherever the reset window supports a projection：以 `projected = percent ÷ elapsed fraction` 推算窗期結束時的用量，`projected > 100%` 為 red（超支）、`> 90%` 為 yellow（快超支）、其餘為 green（有餘裕）。百分比本身回答不了「這樣算多嗎」——weekly 用掉 39% 在第五天是從容，在第二天是失控。

WHERE no trustworthy projection exists, the meter SHALL fall back to the absolute thresholds it used before（`< 70%` green、`< 90%` yellow、否則 red）。無可信投影的情形恰為四種：limit 沒有可用的 `resets_at`（缺少或無法解析）、窗長無法判定、窗期才剛開始（elapsed < `max(60s, 1% of period)`）、或用量低於 5%。最後一項是刻意比 openusage 寬——它只擋紅色、放行黃色，但本專案的顏色是唯一的訊息通道，誤判的黃與誤判的紅一樣會誤導，只是安靜一點。用量 0% 一律 green、≥ 100% 一律 red，兩者都不需要投影。

Window length 的來源分兩路：Codex 的 payload 直接給 `limit_window_seconds`；Claude 的 `/api/oauth/usage` **不含任何 duration 欄位**（實測 live response，`limits[]` 只有 `kind` / `group` / `percent` / `severity` / `resets_at` / `scope` / `is_active`），因此由 `group` 推斷——`session` → 5h、`weekly*` → 7d，認不出來的 limit 不推斷、退回絕對門檻。這是本功能唯一的假設，Anthropic 改窗長時 `src/usage/pace.ts` 是唯一要跟著改的地方。

Colour is the entire feature：no glyph, no extra column, no layout change。[AC-011a](#req-006-usage-meters-in-the-cli) 的 golden fixtures 全部以 `color: false` 產生，所以 Python parity 逐 byte 不受影響——這也是為什麼 pace 走顏色而不是 bar 上的 marker（見 [architecture.md §DEC-012](../architecture.md#dec-012-pace-以顏色表達不在-bar-上加-marker)）。

| AC | Given | When | Then |
|---|---|---|---|
| AC-027 | 同一 provider 兩個帳號，A 的 weekly 用 39% 但窗期只走了 31%，B 的 weekly 用 76% 且窗期已走 76% | `seat` 或 `/seat` | A 的 bar 與百分比為 red，B 為 yellow；絕對門檻下 A 會是 green |
| AC-028 | limit 無 `resets_at`、窗長認不出、窗期未達 `max(60s, 1% of period)`，或用量 < 5% | 渲染該 meter | 顏色為 pace 之前的絕對門檻結果（70 / 90），與本功能上線前一致 |
| AC-029 | 任何 payload、任何寬度 | 以 `color: false` 渲染 | 輸出與 pace 上線前逐 byte 相同（AC-011a 的 golden fixtures 不變）；一列 meter 只讀一次 clock，顏色與倒數描述同一瞬間 |
| AC-030 | limit 的 `resets_at` 無法解析，或 Codex `reset_at` 超出 Date 範圍 | 渲染該 meter | 只損失 reset 欄位：bar 與百分比照常渲染、顏色為絕對門檻、輸出不含 `NaN`、不抛錯 |

## Non-functional

- NFR-001: CLI 冷啟至 `--plain` 輸出 process-cold p95 ≤ 150ms（hyperfine 量測，repo 內提供 benchmark command；prompt segment 可用性；bun 執行）。
- NFR-002: 自 pi-accounts（MIT）改作的程式碼保留 attribution（LICENSE / NOTICE）。

## Retired

已移除的行為，記錄在此以免被誤認為疏漏而重建：

- REQ-008 — claude-profiles.json migration：一次性 operator upgrade path，兩台 operator 機器完成 migration 後整個子系統（script、store module、測試）移除。不要重建自動或手動 migration。
- AC-014 — REQ-008 的 exclusion-rule 驗收，隨 migration 子系統一併移除。
- `save`（捕捉 auth.json 現有 credential 進 store）：獨佔 store 架構下，捕捉共享 grant 正是必須禁止的操作（見 [REQ-007](#req-007-named-login)）。
- Identity attribution（server 端歸屬查詢、`whoami` 的網路路徑）：獨佔 store 下 credential 的 owner 由 login 時的命名決定，無歸屬問題可解。`whoami` 保留為離線指令。
- Pi lock 相容邏輯（45s stale window 對 auth.json.lock）：不再碰 auth.json，改為 store 自己的 lock。

## Related

- [architecture.md §Decisions](../architecture.md#decisions) ← 本契約背後的技術決策（vendored pi-accounts、lock protocol、per-turn overlay、report chrome 與 usage walk 的併發模型）。每條 DEC 自帶 Satisfies，以那邊為準——此處不重述 ID 區間，否則每新增一條 DEC 就會漏更
- [architecture.md §Lock protocol (DEC-003)](../architecture.md#dec-003-store-schema-v1-與-lock-protocol) ← REQ-001/REQ-005 的 store 安全性實作依據
