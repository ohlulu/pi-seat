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

The system SHALL store named profiles for `anthropic` and `openai-codex` in an exclusive store file: OAuth grants for both providers, plus Anthropic Console API keys for `anthropic` ([REQ-013](#req-013-anthropic-api-key-profiles)), and, on each API-key profile, an optional Anthropic Admin key used only to read that key's spend ([REQ-014](#req-014-api-key-spend-per-billing-cycle)). The system SHALL never mutate `auth.json`, and SHALL never copy an `auth.json` credential into the store. Read-only access to `auth.json` is limited to exactly two enumerated uses: the built-in usage snapshot ([REQ-006](#req-006-usage-meters-in-the-cli)), and redeeming that login's banked reset ([REQ-012](#req-012-banked-reset-from-the-usage-view)), which sends the snapshot's access token and never refreshes it; the snapshot content SHALL never be persisted into `seat.json`.

store 路徑：`$PI_CODING_AGENT_DIR/seat.json`（未設 env 時為 `~/.pi/agent/seat.json`），權限 0600，atomic write，cross-process file lock。每個 named profile 持有獨立的 OAuth grant——credential 永不與 auth.json 複製共享，因為 Anthropic refresh token 是 single-use，共享 grant 必然導致 double-spend。

| AC | Given | When | Then |
|---|---|---|---|
| AC-001 | 任一 seat 操作（login/use/rm/rename/usage/reset） | 操作完成 | `auth.json` byte-identical 於操作前（no-write assertion） |
| AC-002 | store 檔不存在 | 首次寫入 | 檔案以 0600 建立；讀取端拒絕 symlink |

### REQ-005: Single-flight refresh

All token refreshes — from the extension or the CLI — SHALL go through a locked store update: acquire lock, re-read, refresh only if still expired, write back, release. The system SHALL never issue two concurrent refresh requests for the same grant.

Lost-response semantics：refresh 已 dispatch 但 response 遺失（timeout、crash）視為暫時性失敗，store 保留舊 credential；下一次嘗試重送同一 token。若 server 端已 commit rotation，重送得到 `invalid_grant`，流入 [REQ-004](#req-004-fail-closed-runtime-application) 的持久性 fail-closed，需重新 login。rotated token 從未被本地收到，此路徑下 grant 本已不可恢復——重送不會損害任何仍持有的 credential。（審查時提出的持久化 `refreshing` 狀態機被論證為同終態且多出誤鎖路徑，否決。）

| AC | Given | When | Then |
|---|---|---|---|
| AC-009 | 兩個 OS process 同時對同一過期 credential 觸發 refresh | 並發執行 | OAuth refresh endpoint 只被呼叫一次；兩邊最終讀到同一顆 rotated credential |

### REQ-007: Named login

`/seat login <selector>` SHALL mint a new OAuth grant through the provider's own login flow and store it under the label. Capturing an existing `auth.json` credential into the store is forbidden：在獨佔 store 架構下，捕捉共享 grant 正是必須禁止的操作（見 [§Retired](#retired) 的 `save`）。

保留 alias 習慣：`-a <alias>` repeatable；`rm`、`rename`、alias resolution 語意與 Python seat 相同。`--api-key`（`-k`）改為儲存一把 Console API key，見 [REQ-013](#req-013-anthropic-api-key-profiles)。

Login 互動對齊 Pi 內建 `/login` 體驗：WHEN the provider flow yields an auth URL or device code, the extension SHALL attempt to open the system browser (best-effort, never fatal) and SHALL render the URL as a clickable (OSC 8) link; completion SHALL be reported with an explicit success or failure notification naming the stored label.

成功通知 SHALL state success in words（`login success`）。`ctx.ui.notify(…, "info")` 在 TUI 渲染成一行 dim 小字，與登入過程中的 progress 通知外觀相同，文字本身是區別它們的唯一手段。CLI 的 stderr 訊息用同一句型。

| AC | Given | When | Then |
|---|---|---|---|
| AC-012 | `/seat login work` 完成 OAuth | 登入成功 | store 新增 work profile；auth.json 未變 |
| AC-013 | label 與既有 profile 重名 | login | 確認後才覆蓋（destructive confirm） |
| AC-021 | login flow 發出 auth_url / device_code 事件 | 事件抵達 | browser opener 被呼叫恰一次（失敗不中斷 flow）；notify 含可點擊 URL；完成時有具名 success/failure 訊息 |

### REQ-013: Anthropic API-key profiles

The store SHALL also hold named `anthropic` profiles whose credential is an Anthropic Console API key, so a session switches between subscription OAuth and Console API billing with the same `use` / `PI_SEAT` / alias mechanics. 動機：Max、Ultra、Team 方案每月發一筆 API credit 到使用者連結的 Console organization，只有該 organization 的 API key 發出的 API 呼叫會扣這筆 credit；Pi 透過 seat 用 OAuth grant 時扣的是 plan 額度。

- Scope：只限 `anthropic`。`openai-codex` 走 ChatGPT backend；OpenAI platform key 屬於 Pi 另一個 `openai` provider，seat 不管理。
- Login：`/seat login <selector> --api-key [-a <alias>]…`（`-k` 同義；CLI `seat login <selector> --api-key …` 亦同）不走 OAuth flow，改為讀一把 key。Extension 以 masked input 讀取（每字元顯示 `•`、游標以反白標示並隨之水平捲動，key 永不出現在畫面上）；CLI 從 stdin 讀一行，stdin 是 TTY 時關閉 echo，所以 key 不會進 argv 或 shell history。既有 label 的覆蓋確認同 AC-013；確認與 piped key 共用同一個 stdin，所以 stdin 不是 TTY 時覆蓋既有 label SHALL fail，並要求改在終端機執行或先 `rm`，而不是把 key 讀成確認的回答。
- Command line：任何 `/seat` 或 `seat` 指令的參數中，只要有形似 secret 的 token（`sk-ant-…`，或 `sk-` 後接 20 個以上字元），指令 SHALL 在做任何事之前拒絕，訊息不回顯該 token，並提醒到 Console 撤銷——它此時已在 shell 或 Pi 的輸入歷史裡，而後續任何錯誤路徑（usage 說明、`no profile or alias "…"`）都會把它印回來。
- Validation：key SHALL start with `sk-ant-`，and SHALL NOT be an OAuth token（`sk-ant-oat…`，pi-ai 會把它當 OAuth 送出）or an Admin key（`sk-ant-admin…`，不能呼叫 Messages API）。Console 目前發 `sk-ant-api03-…` 與 `sk-ant-usr-…` 兩種形狀；其他 `sk-ant-` 形狀交給 live check 判斷。通過 prefix 後送一個 `GET /v1/models`（不產生 token 用量）；非 2xx 或網路失敗即拒絕儲存。
- Runtime：API-key profile 沒有 refresh、沒有 expiry，[REQ-005](#req-005-single-flight-refresh) 的 refresh 與 [REQ-004](#req-004-fail-closed-runtime-application) 的 invalid_grant block 都不適用。Selection、overlay、sentinel 與 per-request provider（AC-034）跟 OAuth profile 相同，request 走 `x-api-key`。Seat 回報給 Pi 的 auth 狀態 SHALL be `api_key`, not OAuth，所以 Pi 不會把它當成 subscription。
- Usage：API-key profile 沒有 plan meter；設定了計算週期時改顯示該週期的已花費，見 [REQ-014](#req-014-api-key-spend-per-billing-cycle)。未設定時，CLI 與 view 照樣列出該帳號，下方兩行說明：`API key — no plan meters`，以及獨立一行的 `balance: platform.claude.com/settings/billing`——分行是為了讓純文字網址在窄終端機也完整；有色彩輸出時第二行是指向 Console billing 頁面的 OSC 8 連結，因為 Anthropic 沒有可查餘額的 API（[DEC-015](../architecture.md#dec-015-api-key-profile-是-schema-v1-的第二種-credential)）。這不算 failure（CLI exit code 不受影響），active 時照樣亮點。`--json` 不在 `profiles` 裡列它，`active` 照樣指名它。View 上對它按 `x` 只回報它沒有 banked reset，不發 request。`seat status --plain` 的 expires 欄是 `-`。
- Secrets：key 與 OAuth token 同一等級：存在 0600 的 store、所有錯誤訊息都經 redaction、永不印出。
- Downgrade：store 仍是 version 1，只是多了一種 credential type。0.5.0 以前的 pi-seat 讀到含 API-key profile 的 store 會整份拒絕（全部 provider fail closed），刪掉該 profile 或升級即恢復；沒有 API-key profile 的 store 不受影響。

| AC | Given | When | Then |
|---|---|---|---|
| AC-040 | 既有、只含 OAuth profile 的 `seat.json`（version 1） | 新版載入，以及任何不新增 API key 的操作 | 解析成功，未變更的內容 byte-identical；`openai-codex` 底下的 `api_key` credential 被 schema 拒絕 |
| AC-041 | `/seat login console --api-key` 或 `seat login console --api-key` | 輸入合法 key | live check 通過後 store 新增 `{ type: "api_key", key }` profile；key 不出現在畫面、stdout、stderr 或 argv；`auth.json` 未變 |
| AC-042 | 輸入 `sk-ant-oat…`、`sk-ant-admin…`、非 `sk-ant-` 開頭的字串，或 live check 回非 2xx；或 key 直接寫在指令參數上；或以 pipe 覆蓋既有 label | login（或任何指令） | 拒絕、store 未變、錯誤訊息不含 key；參數上的 key 不觸發任何 prompt 或 request |
| AC-043 | pin 或 default 指向 API-key profile | turn 與 subagent child 的 request | request auth 是該 key、零 refresh request；Pi 的 auth check 回報 `api_key` |
| AC-044 | API-key profile 存在 | `seat`、`/seat` view、在該列按 `x` | 該列顯示 no-plan-meters 說明與獨立一行的 billing 網址（有色彩時是連結、無色彩時是純文字，50 欄仍完整），active 時亮點；CLI exit 0；`x` 零 request |

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

Extension 載入對 store 的保證（AC-020）：載入永不建立 `seat.json`、永不改變 credential 內容、也永不執行任何 legacy 匯入——這條規則是 load-time 匯入專屬測試得以刪除的依據，由 `scripts/smoke-extension.sh` 對 store 缺席與 store 既存兩種情境斷言。載入不是字面上 side-effect-free：init 經由 store 的 read path 解析 pin，該路徑會短暫取得 file lock，並把既有檔案的 mode 重新收斂到 0600（刻意的 defense in depth——每次讀取都把持有 OAuth credential 的檔案硬化回 0600）。AC-020 的範圍是載入本身；之後的 `session_start` 同步（AC-033）跟 turn 一樣，可能對已過期的 credential 執行 [REQ-005](#req-005-single-flight-refresh) 的 locked refresh 並寫回 rotation。

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

fail-closed 狀態只存在記憶體，不落盤：暫時性失敗（網路抖動）下一個 turn 自動重試復原；持久性失敗（refresh token 死亡）持續擋住直到重新 login。

Turn 之外的呼叫者（AC-033）：extension 可以在任何 turn 之前直接呼叫 model——例如在新 session 第一個 prompt 之前執行的 slash command，透過 `ctx.modelRegistry.getApiKeyAndHeaders` 取 credential。只在 `turn_start` 套用時，這種呼叫找不到 overlay，會退回 Pi 內建的 `auth.json` login：用的不是 seat 選擇的帳號，而該 grant 若已過期就是 `invalid_grant`。因此 extension SHALL also apply the overlay at `session_start`, with the same sequence and the same sentinel rules. 這時沒有 turn 可以中止，所以每個失敗都走非致命路徑（poison + notify），sentinel 裝不上去時一樣升級為 abort handler 回報（AC-032 的規則）。Startup error 或缺少 runtime overlay 時，`session_start` 什麼都不套用，交給第一個 `turn_start` 依 AC-004 與版本檢查 fail-closed。

Subagent children（AC-034）：pi-subagents 的 foreground child（`async: false`）跑在一個全新的 `ModelRuntime` 上，不載入任何 extension，只繼承 parent 透過 `pi.registerProvider` 註冊的 provider——per-turn overlay 到不了那裡，child 會退回 `auth.json` 的 grant。The extension SHALL therefore also resolve every request to a seat-managed provider through seat, in every runtime that holds seat's registered provider：同一份 selection（init 解析的 pin > store default）、同一條 [REQ-005](#req-005-single-flight-refresh) locked refresh、同一個 fail-closed block。seat 擁有該 provider 時，Pi 的 `auth.json` grant 不被 refresh 也不被寫入；失敗時 request 以 seat 的錯誤失敗，絕不退回 `auth.json`。這條路徑沒有 turn 可以中止，fail-closed 的形式就是該 request 本身失敗。Startup error（AC-004）同樣讓這些 request 失敗，而不是放行。Background child 自己載入 extension，走的仍是 per-turn overlay。

中止的範圍是「這個 turn 實際會用到的 provider」：兩個 provider 每個 turn 照樣同步、照樣安裝 sentinel、照樣記住 block，但只有 active model 所屬的 provider 失敗才 abort。壞掉的 anthropic profile 因此擋不住跑在 codex 或任何非 seat provider（cursor、google……）上的 turn——那條路本來就不需要這份 credential，而「額度沒了就換模型繼續做事」是這個設計要保住的逃生門。Active model 無法辨識時回到最保守的行為：任何失敗都 abort。

| AC | Given | When | Then |
|---|---|---|---|
| AC-007 | refresh 失敗（模擬 invalid_grant），active model 屬該 provider | turn 開始 | turn 中止並顯示原因；store 內 credential 未被刪除 |
| AC-008 | overlay 流程任一步 throw（含 sentinel 安裝自身），active model 屬該 provider | turn 開始 | turn 先被 abort，provider request 零次發出 |
| AC-031 | anthropic profile 已死（invalid_grant） | turn 跑在非 anthropic 的 model 上 | turn 不中止、request 照發；anthropic 仍被 block 並裝上 sentinel，並以非致命訊息回報；下一個跑在 anthropic 上的 turn 才中止 |
| AC-032 | 同 AC-031，但 sentinel 裝不上去（set 丟錯或 read-back 不符） | turn 開始 | 升級為 abort：非致命路徑的存活條件是該 provider 確實已被 poison |
| AC-033 | 有效的 pin 或 default；尚未執行任何 turn | `session_start` | 兩個 provider 的 overlay 都已套用，turn 之外的 model 呼叫使用 seat credential；失敗只 poison 並 notify，不中止任何東西；startup error 時不套用任何 overlay |
| AC-034 | seat 的 pin 或 default 生效；`auth.json` 同 provider 的 grant 已死；foreground subagent child（全新 `ModelRuntime`、不載入 extension、只繼承 parent 註冊的 provider） | child 發出該 provider 的 request | 使用與 parent 相同的 seat profile（pin > default）；`auth.json` 未被 refresh 且 byte-identical；seat profile 已死或 startup error 時 request 以 seat 的錯誤失敗，而非 `auth.json` 的 refresh 錯誤；無 pin 無 default 時走 Pi 內建登入（AC-006）；同一 process 內並發的 child 對同一顆過期 grant 只 refresh 一次且不死鎖 |

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
| `seat login <selector> [--api-key\|-k] [-a\|--alias <alias>]…` | named login，alias repeatable；`--api-key`（`-k`）從 stdin 讀 Console API key（[REQ-013](#req-013-anthropic-api-key-profiles)） |
| `seat since <selector> <date>` / `seat since <selector> --clear` | 設定或清除 API-key profile 的每月計算週期（[REQ-014](#req-014-api-key-spend-per-billing-cycle)） |
| `seat admin-key <selector>` / `seat admin-key <selector> --rm` | 從 stdin 讀入或刪除該 API-key profile 的 Anthropic Admin key（[REQ-014](#req-014-api-key-spend-per-billing-cycle)） |
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

Destructive operations (`rm`, `login`) SHALL NOT be reachable from the view：它們需要巢狀對話框，而巢狀 `ctx.ui.custom()` 漏帶 `{ overlay: true }` 會讓 base component 的 promise 永不 resolve（見 `pi.md` extension gotchas）。`use` 非破壞性且可逆，不需確認。唯一的例外是 [REQ-012](#req-012-banked-reset-from-the-usage-view) 的 reset：它的確認是 view component 自己的一個 state，畫在自己的 rows 裡，不開任何 nested UI，所以那個 gotcha 碰不到它。

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

### REQ-012: Banked reset from the usage view

WHEN the user presses `x` on an account row of the in-session usage view ([REQ-010](#req-010-in-session-usage-view)), the extension SHALL look up the banked usage-limit reset that account would redeem next, show an inline confirmation naming it, and redeem it only after `y`. 兩個 provider 都發這種券：Codex 叫 reset credit，Anthropic 叫 limit reset（社群稱 banked reset）；兩者都沒有公開文件，wire contract 的來源記在 [architecture.md §DEC-014](../architecture.md#dec-014-banked-reset-是-view-的-inline-state)。

哪一張：Codex 用最早到期的 `available` credit（用後面那張會讓這張白白過期）；Anthropic 用 server 在 `next_grant_id` 指名的 grant，其他 grant 會被以 `not_next_grant` 拒絕。Lookup SHALL be fresh at `x`, and an unreadable lookup reply SHALL report a failed check, never "no resets"：畫面上的張數可能已經是幾分鐘前的，而確認必須指名 redeem 要送出的那一張。確認內容包含券名、期限、會補滿哪些窗、剩餘張數，以及 server 可能拒絕的原因（Codex 只在至少補滿一個窗時才扣券；Anthropic 的券可能要求已經撞到上限）。

Confirmation 是 view 的 state，不是第二個 `ctx.ui.custom()`。它開著的時候接管鍵盤：`esc` 與 `n` 的意思是「保留這張券」，只關確認、不關 view。Redeem 送出後沒有可以收回的東西，所以 in flight 期間所有按鍵無效。Redeem SHALL never be retried automatically：每次嘗試帶新的 idempotency key，重送等於一個新的 request。

結果分三類，訊息各自說清楚券還在不在：

- `reset`：券已使用、limit 已改變，view 重新抓 usage。這是除了 `r` 之外唯一會 refetch 的動作（對照 AC-023 的 zero-refetch）。
- Server 明確拒絕（Codex `nothing_to_reset`/`no_credit`/`already_redeemed`、Anthropic `not_limited`/`already_used`/`cooldown`/`ineligible`/`unavailable`、HTTP 401/403/429），以及 redeem request 送出之前的失敗（Anthropic 的 profile 查詢或 organization 驗證）：不 refetch，狀態列說這次請求沒有消耗任何東西，並照實說出原因——多數情況券仍可用（`nothing_to_reset`、`not_limited`、`cooldown`、狀態碼拒絕），但 `already_redeemed`/`already_used` 表示那張券已被用掉，`no_credit` 表示沒有可用的券。
- 曖昧（redeem 送出後的 5xx、timeout、無法解析的 body）：可能已經 commit，所以說 `not confirmed` 並提示按 `r` 確認，絕不說 `nothing was used`。

Credential：store profile 走 [REQ-005](#req-005-single-flight-refresh) 的 locked refresh（一個 store task，DEC-013）；built-in login 讀 `auth.json` 快照並且 SHALL NOT refresh it（DEC-005），過期時只提示、不發 request。

Count：meter block 下的 `credits` 列顯示剩餘張數。Codex 來自 `rate_limit_reset_credits.available_count`（既有的 Python parity 列，AC-011a 釘住）；Anthropic 是 `cedar_ember.grants[].resets_left` 的總和，沿用同一個標籤，讓同一個概念在畫面上只有一個詞。為 0 或區塊不存在時不出現這列。CLI 共用同一個 renderer，所以 `seat usage` 也顯示張數，但 redeem 只在 view 裡。

Anthropic 以 client identity 判斷資格（實測：其他 User-Agent 拿到 `ineligible_reason: "surface"`），所以所有 Claude request（usage、profile、redeem）SHALL carry Claude Code's identity：`User-Agent: claude-cli/<version> (external, cli)` 與 `x-app: cli`。Usage URL 帶 `cedar_ember=1`（沒帶就沒有這個區塊），不帶 `skip_spend=1`（實測會改變 meter 要畫的 `extra_usage`）。

Scope：只有 view 能 redeem，沒有 `/seat reset` 指令、也沒有 CLI 指令。Anthropic 的另一個 reset program `juniper_tide`（每週一次的 session-limit reset，實驗中的功能）不在範圍內。

| AC | Given | When | Then |
|---|---|---|---|
| AC-035 | 帳號有可用的券 | view 載入後按 `x` | meter block 有 `credits N`；確認列出券名、期限、剩餘張數，有拒絕風險時加上原因；按 `y` 之前零個 redeem request；沒有券時只顯示狀態列、不開確認 |
| AC-036 | 確認已開啟 | 按 `esc` 或 `n`；或在 redeem in flight 時按 `esc` / `y` | 前者只關確認、view 仍開著、零 redeem；後者全部無效，恰好送出一個 redeem |
| AC-037 | 已按 `y` | server 回 `reset`、明確拒絕、或曖昧的失敗 | `reset`：usage 被 refetch，狀態列說 reset used；拒絕：零 refetch，狀態列說這次沒有消耗並照實說明原因（券保留、券已被用掉、或沒有券）；曖昧：說 `not confirmed`，絕不說 `nothing was used` |
| AC-038 | 游標在 built-in login | redeem；或快照已過期 | 使用 `auth.json` 快照的 access token，`auth.json` byte-identical；快照過期時只提示，不 refresh、不發 request |
| AC-039 | 任何 Claude request | 送出 | 帶 `claude-cli/<version> (external, cli)` UA 與 `x-app: cli`；usage URL 帶 `cedar_ember=1`、不帶 `skip_spend` |

### REQ-014: API-key spend per billing cycle

WHERE an API-key profile ([REQ-013](#req-013-anthropic-api-key-profiles)) has a billing cycle and an Admin key, the CLI and the usage view SHALL show that key's spend since the current cycle started, in place of the billing link. 動機：Anthropic 沒有查餘額的 API（[DEC-015](../architecture.md#dec-015-api-key-profile-是-schema-v1-的第二種-credential)），但 Usage and Cost Analytics API 能依 API key 回報指定期間的花費；已花費加上使用者自己知道的月額度，就足以判斷還能用多少。Seat 不推算餘額。

- Cycle：`seat since <selector> <date>`（`/seat since` 同義）。`<date>` 接受 `MM/DD/YYYY` 與 `YYYY-MM-DD`，其他寫法與不存在的日期一律拒絕（exit 2）。日期是第一個週期的起點，日期中的「日」是之後每月的 reset 日；某月沒有該日時，reset 落在當月最後一天（31 → 2 月 28/29 日）。起點是該日 `00:00`，時區是執行 `since` 時系統的 IANA 時區，存進 store、之後不隨機器改變。只接受 API-key profile，OAuth profile 拒絕（exit 1）。`--clear` 移除週期，回到 billing 連結。改週期不刪任何資料，因為 seat 不存花費。
- Admin key：`seat admin-key <selector>` 從 stdin 讀一行（TTY 時關 echo），`/seat admin-key <selector>` 用 [REQ-013](#req-013-anthropic-api-key-profiles) 的 masked input；`--rm` 刪除；只接受 API-key profile。Key SHALL start with `sk-ant-admin`；儲存前送一個 `GET /v1/organizations/api_keys?limit=1`，非 2xx 或網路失敗即拒絕。Admin key 屬於 Console organization，所以綁在 profile 上：分屬不同 organization 的 API key 各自帶自己 organization 的 Admin key；同一 organization 的多把 key 各設一次。已有 Admin key 時直接取代。它跟著 profile 走：`rename` 帶著它，`rm` 一併刪除，`login` 覆蓋該 profile 時與 `cycle` 一起清除（新 key 可能屬於別的 organization）。它能管理整個 organization，所以與 profile credential 同等級：0600、redaction、永不印出，[REQ-013](#req-013-anthropic-api-key-profiles) 的 argv secret 拒絕同樣涵蓋它。Admin key 永不用來送 model request。
- Lookup：以 Admin key 列出 organization 的 API key，用 `partial_key_hint`（`<前綴>...<後綴>`）比對 profile 的完整 key，恰好一個 active key 符合才算找到；再以 `GET /v1/organizations/analytics/cost` 查 `api_key_ids[]=<id>`、`starting_at=<週期起點>`、不分 bucket 的總額。`cost.amount` 是扣 credit 前的花費（cents 字串），加總後顯示為美元。查詢走 usage walk 的 endpoint 階段，與其他帳號併發。
- Display：`spent $23.47 since 2026-11-27` 一行，下一行 `resets 2026-12-27 · data as of 14:05`。資料時間取 response 的 `data_refreshed_at`，以週期時區顯示，因為官方資料最多延遲 24 小時，沒有它的話剛用掉的花費會像沒算到；response 沒帶這個欄位時寫 `data time unknown`，不省略。分頁中途缺 cursor 或超過頁數上限時整列算 failure，絕不顯示只加總一部分的金額或只比對一部分的 key 清單。`since` 寫入前驗證時區是 IANA zone，否則拒絕並請使用者設定 `TZ`，因為 schema 讀不懂的時區會讓整份 store 無法載入。今天早於第一個週期起點時顯示 `cycle starts 2026-11-27`，不送 cost request，也不顯示 `$0.00`。
- Failure：缺 Admin key、key 不在該 Admin key 的 organization、比對到多個 key、HTTP 錯誤，都在該列以一行說明取代花費，並計為 failure（CLI exit 1），因為使用者已明確要求這個數字。說明不含任何 key。沒有設定週期的 API-key profile 維持 REQ-013 的行為：不是 failure、零 request。
- Scope：只限 `anthropic` 的 API-key profile。`--json` 本輪不加 spend 欄位。View 的 `x` 行為不變。
- Downgrade：store 仍是 version 1，API-key profile 多出可選的 `cycle` 與 `adminKey`。0.6.0 以前的 pi-seat 讀到任一欄位會整份拒絕 store；對每個 profile 執行 `seat since … --clear` 與 `seat admin-key … --rm` 之後即可降級。

| AC | Given | When | Then |
|---|---|---|---|
| AC-045 | API-key profile `console` | `seat since console 11/27/2026`、`seat since console 2026-11-27`、`seat since console 2/30/2026`、對 OAuth profile 執行 | 前兩者在 store 寫入同一個 `{ anchor: "2026-11-27", timeZone }`；不存在的日期 exit 2、OAuth profile exit 1，store 皆未變 |
| AC-046 | anchor `2026-01-31`、時區 `Asia/Taipei` | 計算 2026-02-15、2026-03-05、2026-01-20 的週期 | 依序為 `2026-01-31`→`2026-02-28`、`2026-02-28`→`2026-03-31`、尚未開始；起點是當地 00:00 換算成 UTC |
| AC-047 | API-key profile `a`、`b` 與 OAuth profile `o` | `seat admin-key a` 輸入非 `sk-ant-admin` 開頭的字串、live check 非 2xx，或 key 寫在參數上；對 `o` 執行 | 拒絕、store 未變、輸出不含 key；合法 key 通過 live check 後只存到 `a`，`b` 不受影響，`auth.json` 未變 |
| AC-048 | 週期已開始，profile 有 Admin key，cost API 回兩列 `"1234.000000"` 與 `"1000.000000"` | `seat`、`/seat` | 該列顯示 `spent $22.34 since …` 與 reset 日、資料時間；沒有 billing 連結；其他帳號照常渲染 |
| AC-049 | 缺 Admin key、hint 比對到零個或多個 key、cost API 401 | `seat` | 該列顯示對應說明，exit 1，輸出不含任何 key；未設週期的 API-key profile 照舊零 request、exit 0 |

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
