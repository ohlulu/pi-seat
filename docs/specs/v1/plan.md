---
summary: pi-seat v1 technical plan — decisions (vendored pi-accounts, lock protocol, per-turn overlay), change map, AC-to-test verification matrix, cutover rollout
read_when:
  - Implementing any pi-seat module or deciding where new code lives
  - Writing or updating tests against the verification matrix
  - Executing the rollout or a rollback
---

# pi-seat v1 — Plan

## Technical approach

- 單一 TS monorepo（bun + TypeScript）：`src/store`、`src/usage` 為純模組，`src/extension` 與 `src/cli` 是兩個薄入口，共用前兩者。
- Credential lifecycle 層改作自 pi-accounts（MIT）：`storage.ts`（locked atomic store）、`runtime-auth.ts`（coordinator / overlay / fail-closed / verify）、`oauth.ts`（重用 Pi 內建 provider 的 login/refresh/toAuth）。改作而非依賴：要改 selection resolution（env pin）、store schema（aliases、seat 命名）與 UI 層（seat 習慣的指令集）。
- Per-turn lifecycle：上游 pi-accounts 只在 `before_agent_start` sync，不符 REQ-004——Pi 一次 agent loop 可有多個 turn，tool continuation 可能騎在過期或已切換的 credential 上。本專案的 async `turn_start` handler 每個 turn 執行 selection → locked refresh → toAuth → overlay → verify；任一步失敗（含 sentinel 安裝自身）先無條件 `ctx.abort()`，再 best-effort 安裝 sentinel。
- Pi compatibility：runtime overlay 依賴 Pi 內部 `ModelRuntime.setRuntimeApiKey/removeRuntimeApiKey`（非公開 ExtensionAPI；於 Pi 0.84.2 驗證）。startup 做 feature detection，缺失時 fail-closed 並提示版本不相容。Pi upgrade 為已知 residual risk。
- Selection resolution 是本專案唯一的新核心邏輯：`env pin > store default > Pi built-in`，pin（含 alias→label 解析）在 extension init 讀一次 `PI_SEAT`，天生 session-scoped。
- Usage 渲染自 Python seat 移植為純函式模組（`cells.ts`、`layout.ts`、`render.ts`），以 golden output 對照 Python 版驗證行為等價。
- Python seat 退役：`~/.pi/agent/bin/seat` 原路徑改為指向本 repo build 的 bun shim（dotfiles allowlist 路徑不變）。

## Decisions

### DEC-001: Adapt pi-accounts, not depend on or PR to it

- Choice: 把 pi-accounts 的 storage / runtime-auth / oauth 三層 vendor 進來改作，保留 MIT attribution。
- Alternatives: (a) 直接依賴 `@narumitw/pi-accounts` 並包一層；(b) 上游 PR 加 env pin。
- Rationale: (a) 它的 store schema、`/accounts` UI 與全域 `active` 都不符需求，包一層要對抗的比重寫的多；(b) env pin 或許可上游，但 seat 命名、aliases、CLI、usage 完全是本地需求。改作讓我們擁有整條 credential 路徑。上游修 bug 時手動 cherry-pick。
- Satisfies: REQ-001, REQ-004, REQ-005。

### DEC-002: Selection resolution — env pin 讀一次；`use` 一律持久化

- Choice: extension init 時解析 `PI_SEAT`（含 alias→label，一次解析不重解析）存為 immutable session pin。`/seat use` 在任何 session 都寫入 global default；目標 provider 有 pin 時照樣寫入，並提示「default 已更新，本 session 維持 pin」；未 pinned 的 provider 立即套用新 default。
- Alternatives: 每 turn 重讀 env 或重解析 alias（mid-session rename 會靜默 retarget 既有 pin，違反 pin 的 immutability；dangling 情況由 per-turn profile lookup 的 fail-closed 涵蓋）；pinned session 拒絕 `use`（違反「use 寫 global default」的 locked semantics，且擋住在 Codex pin 下更新 Anthropic default）。
- Satisfies: REQ-002, REQ-003。

### DEC-003: Store schema v1 與 lock protocol

- Choice: 單檔 `seat.json`：`{ version: 1, providers: { <id>: { default?: label, profiles: { label: credential }, aliases: { alias: label } } } }`。own-property 存取（label 是使用者輸入，防 `__proto__`）、0600、O_NOFOLLOW、atomic rename、`proper-lockfile`（與 Pi 同一套 lock 函式庫，但鎖自己的檔案）。
- Lock protocol（所有 process 必須一致）：
  - `realpath: false`（預設 `realpath: true` 在 target 不存在時 ENOENT，first-create 會炸；Pi 自身的 auth-storage 同樣設定）。
  - 統一 `stale` / `update` 參數與 lock path。
  - first-load / migration 條件在取得 lock 後重查（lock 內 re-check）。
  - lock compromised 後禁止 commit——失鎖狀態下寫入會覆蓋另一 process 的 rotated credential。
  - temp file 以 0600 / O_EXCL 建於 `dirname(seat.json)`，同 volume rename 完成 atomic write。
- Alternatives: 沿用 claude-profiles.json 格式（無 provider 維度、identities 欄位已無用途）。
- Satisfies: REQ-001, REQ-005, REQ-007。

### DEC-004: CLI runtime 與 width 計算

- Choice: CLI 以 bun 直跑 TS（shim: `#!/usr/bin/env bun`）；cell width 自行移植 Python 的 `cell_width`（East Asian W/F = 2，Ambiguous = 1，約 30 行 + 對照測試），不引入 string-width 或 pi-tui 依賴。
- Rationale: NFR-001 的啟動預算容不下重依賴；Ambiguous=1 的行為必須與 Python 版完全一致，第三方套件對 Ambiguous 的處理不受控。
- Satisfies: REQ-006, NFR-001。

### DEC-005: CLI 對 store credential 有 refresh 權，對 auth.json 沒有

- Choice: CLI 的 usage 流程對過期 store credential 走 REQ-005 的 locked refresh；auth.json 的內建登入 credential 一律不碰（讀都用唯讀快照，過期只提示）。
- Rationale: store grant 是我們獨佔的，refresh 安全；auth.json 的 grant 是 Pi 的，動它就回到 Python seat 的整套 attribution 地獄。
- Satisfies: REQ-005, REQ-006。

### DEC-006: 部署形態

- Choice: repo 常駐 `~/Developer/ohlulu/pi-seat`；Pi 以 local package path 載入 extension（`~/.pi/agent/settings.json` packages 條目，經 `package.json` 的 `pi.extensions` manifest 指到 extension 入口）；CLI shim 覆蓋 `~/.pi/agent/bin/seat`（路徑不變，dotfiles `gg_add_allowlist` 無需改動）。不發 npm。
- Alternatives: 發 npm 走 `pi install`（個人工具，發佈成本無收益）。

### DEC-007: In-session usage view 復用 usage 純模組

- Choice: `/seat`（無參數）與 `/seat status` 在 TUI 開 `ctx.ui.custom()` component（`src/extension/usage-view.ts`），直接吃 `src/usage` 的 cells/layout/render 輸出；`esc`/`q` 關閉。非 TUI（`ctx.mode !== "tui"`，不用 `hasUI`）退回文字。
- 守則（來自 pi.md 實證 gotchas）：spinner 重繪必須回傳 `dispose`；view 開啟中不另開 nested UI；寬度安全走既有 `fit`/`cell_clip`，並以 render probe 掃 width 2–200 驗證無 row 溢出（含固定 chrome 字串）。
- Alternatives: statusbar 常駐元件（資訊密度不够，且佔永久螢幕空間）。
- Satisfies: REQ-010。

## Change Map

| File | Action | Satisfies |
|---|---|---|
| `package.json` | create — bun scripts、dependencies、`pi.extensions: ["./src/extension/index.ts"]` manifest | DEC-006 |
| `tsconfig.json` | create — TS 設定 | DEC-006 |
| `bun.lock` | create — lockfile | DEC-006 |
| `LICENSE` | create — 本 repo license | NFR-002 |
| `NOTICE` | create — pi-accounts（MIT）attribution | NFR-002 |
| `src/store/schema.ts` | create — schema v1 types + parse/validate（own-property） | REQ-001 |
| `src/store/storage.ts` | create — 改作 pi-accounts storage.ts：lock protocol（DEC-003）、0600、O_NOFOLLOW、atomic write | REQ-001, REQ-005 |
| `src/store/refresh.ts` | create — locked single-flight refresh（extension 與 CLI 共用） | REQ-005 |
| `src/store/migrate.ts` | create — claude-profiles.json 匯入（REQ-008 排除規則，lock 內 re-check） | REQ-008 |
| `scripts/migrate-legacy.ts` | create — 手動 migration 進入點（dry-run 預設、`--apply`）；extension 不自動觸發 | REQ-008 |
| `src/store/selector.ts` | create — selector grammar parse + resolution（pin > default > built-in）；extension 與 CLI 共用的純模組 | REQ-002, REQ-003 |
| `src/extension/index.ts` | create — extension 入口：pin 解析、per-turn sync、`/seat` 指令、runtime feature detection | REQ-002, REQ-003 |
| `src/extension/runtime-auth.ts` | create — 改作 pi-accounts：coordinator、overlay、abort-first fail-closed、verify、`closeOpenAICodexWebSocketSessions(sessionId)` invalidation | REQ-004, REQ-009 |
| `src/extension/oauth.ts` | create — 改作 pi-accounts：anthropic + openai-codex adapters（重用 Pi 內建 OAuth） | REQ-007 |
| `src/extension/commands.ts` | create — `/seat` 子指令：login/use/rm/rename/status + shorthand + aliases + selector grammar | REQ-002, REQ-003, REQ-007 |
| `src/extension/usage-view.ts` | create — in-session usage view（ctx.ui.custom、esc/q、非 TUI fallback） | REQ-010 |
| `src/usage/cells.ts` | create — cell_width / cell_clip / fit 移植 | REQ-006 |
| `src/usage/layout.ts` | create — layout tiers 移植 | REQ-006 |
| `src/usage/render.ts` | create — bars / account blocks / spinner 移植 | REQ-006 |
| `src/usage/fetch.ts` | create — Claude oauth/usage 與 Codex wham/usage endpoints（沿用 Python 版 headers） | REQ-006 |
| `src/cli/main.ts` | create — CLI 入口：REQ-006 synopsis、stdout/stderr 分工、exit codes 0/1/2 | REQ-003, REQ-006 |
| `test/fixtures/generate-python-golden.py` | create — deterministic golden generator：固定 clock、timezone、payload、color、spinner、width | REQ-006 |
| `test/**` | create — 見 Verification | all |
| `~/.pi/agent/settings.json` | edit — packages 加 local path（dotfiles repo） | DEC-006 |
| `~/.pi/agent/bin/seat` | replace — Python 檔換 bun shim（dotfiles repo，路徑不變） | DEC-006 |

## Verification

AC-to-test matrix（bun test，除另註明）：

| AC / NFR | Test |
|---|---|
| AC-001 | 每個整合測試 teardown 斷言 `auth.json` byte-identical |
| AC-002 | storage unit：首次建立 mode 0600；symlink target 拒讀 |
| AC-003 | tmux 兩個 pinned session 並行 smoke（真實 Pi） |
| AC-004 | extension init：nosuch label、malformed / duplicate-provider selector → startup 報錯、該 provider turn 中止 |
| AC-005 | `use` 寫 default；新 spawn 的無 pin session 讀到新 default |
| AC-006 | 無 default 無 pin → runtime 零 override（feature-detection spy 斷言未呼叫 setRuntimeApiKey） |
| AC-007 | fake adapter 注入 invalid_grant → turn 中止、credential 未刪 |
| AC-008 | runner-level integration：refresh / toAuth / apply / verify / sentinel 各自 throw → abort 先行、provider stream 呼叫零次 |
| AC-009 | 兩個真實 OS child process 並發 refresh → endpoint 恰一次；另測 stale-lock takeover 與 first-create |
| AC-010 | dormant expired profile → locked refresh → bar 渲染 |
| AC-011a | golden fixtures：width 2–200 掃描逐列比對 Python golden |
| AC-011b | width ≥ 40 semantic assertions：account name / meter label / percent 存在、截斷帶 ellipsis |
| AC-012 / 013 | fake OAuth adapter login flow；重名 → confirm 後才覆蓋 |
| AC-014 | migration fixture：legacy `active` pointer 與 byte-equality 不一致 → 兩條排除規則各自生效；ambiguous fixture → fail-closed |
| AC-015 | injected invalidator spy：identity A→B 恰一次、A→A 零次、close 完成後才回報切換成功 |
| AC-016 | pinned session `use` → default 寫入 + pin 維持 + 提示訊息 |
| NFR-001 | `hyperfine 'seat status --plain'`，process-cold p95 ≤ 150ms，run count 固定於 repo script |
| NFR-002 | LICENSE / NOTICE 存在性檢查 |

補充測試：

- Per-turn re-apply（two-turn test）：第一個 tool call 後改 default 或令 token 過期，斷言第二次 provider request 使用新 credential。
- Extension smoke（真實 Pi）：`pi -ne -e ./src/extension/index.ts` 確認 tool list 不消失；tmux 驅動 TUI 驗證 `/seat` 指令。
- CLI 契約：legacy invocation `seat usage --json` 必須通過；bad invocation exit 2；prompts/diagnostics 只在 stderr。
- Golden fixtures 在替換 Python shim 前以 `generate-python-golden.py` 產生並 commit；Python 無法表達的狀態（named Codex、雙 provider、expired-refresh）另定 TS-native expected fixtures。

## Migration / rollout

1. repo 完成、全部測試綠。
2. 一次性 cutover（先停止所有 pi session 與 seat 呼叫）：跑 `bun scripts/migrate-legacy.ts --apply` 執行 REQ-008 migration，接著 settings.json 掛上 extension、`bin/seat` 替換為 bun shim（Python 版移入 repo 的 `legacy/` 留檔）。legacy 的 `use`/`save` 寫入路徑自此退役——不存在 legacy switcher 與 `seat.json` 同時可寫的期間（避免同一 grant 雙方 refresh 的 double-spend）。
3. `/seat login` 逐帳號建立新 grant（或使用 migration 匯入的 dormant profiles）。
4. 驗證雙 session pin 工作流跑順一週。
5. Rollback：停止所有 Pi/CLI process → settings.json 移除 package → 還原 Python `bin/seat`（git revert dotfiles）。注意：已 migrate 且用過的 profile，其 refresh token 已 rotate 進 `seat.json`，legacy 檔中是已 spent token，該帳號可能需重新 login/save。保留 `seat.json` 直到 rollback 驗證完成；最後跑 `seat status` 與一次 usage check 確認。
6. Post-transition cleanup：步驟 3–4 驗證完成、rollback 窗口過後，移除 migration 路徑（`src/store/migrate.ts`、`scripts/migrate-legacy.ts`、對應測試）並同步攸除 REQ-008。它是一次性 upgrade path（服務對象只有本機的 Python seat legacy store，對其他使用者永遠 no-op），不是永久 compat contract。

## Open questions

無 — usage surface（TS monorepo）、provider 範圍（anthropic + codex）、切換語意（use 寫 global default）、repo 名稱已由使用者拍板。

## Review Dispositions

三個 critic lens（data safety / integration / spec quality）平行審查，round 2 全數 RESOLVED。同一 failure mode 的跨 lens 重複項已合併至最高 severity。

| Finding | Disposition | Resolution |
|---|---|---|
| [P0] REQ-001「絕不讀 auth.json」與 REQ-006/008 矛盾（三 lens 皆中） | accept | REQ-001 改為 never-mutate / never-copy，明列兩個 read-only access |
| [P0] DEC-002 pinned session 拒絕 `use`，違反 locked「use 寫 global default」（兩 lens 皆中） | accept | `use` 一律持久化，pinned session 附提示（AC-016） |
| [P0] Rollout 共存期 legacy seat 可把已匯入 grant 寫回 auth.json → double-spend | accept | rollout 改一次性 cutover，legacy 寫入路徑同步退役 |
| [P0]「永不 refresh 兩次」與自動重試矛盾 | accept（amended fix） | REQ-005 縮限為禁止 concurrent refresh；lost-response 重送走 invalid_grant → fail-closed。critic 原提案的持久化 `refreshing` 狀態機被論證為同終態且多出誤鎖路徑，round 2 CONCEDE |
| [P0] AC-011 在 width 2–3 物理上不可能（Python 會裁光內容） | accept | 拆為 AC-011a（golden 等價）與 AC-011b（width ≥ 40 semantic retention） |
| [P1] Migration byte-equality 認不出 rotated active lineage | accept | 無條件排除 legacy `active` + refresh-token 比對 + ambiguous fail-closed |
| [P1] Provider-qualified selector grammar 未定義 | accept（amended fix） | REQ-002 補完整 grammar；alias 改為 init 一次解析（per-turn 重解析會讓 mid-session rename 靜默 retarget pin），round 2 CONCEDE |
| [P1] `status --plain` 雙 provider 下無唯一契約 | accept | 明訂 Anthropic-only 四欄 TSV，`active` = 本 process 有效 selection |
| [P1] Change Map 缺 package scaffolding 與 attribution files | accept（new-mechanism 1/2） | 補 package.json（pi.extensions manifest）、tsconfig、bun.lock、LICENSE、NOTICE |
| [P1] Golden fixture 無可重現生成流程 | accept（new-mechanism 2/2） | 新增 deterministic `generate-python-golden.py`，shim 替換前產生並 commit；新狀態用 TS-native fixtures |
| [P1] Verification 未形成 AC-to-test closure（含 AC-015 漏測，跨 lens 合併） | accept | 補 AC-to-test matrix；AC-009 用真實雙 process；AC-015 用 invalidator spy |
| [P2] Sentinel 自身失敗時 Pi runner 吞例外繼續發請求 | accept | abort 先行、sentinel best-effort；runner-level 零 provider-call 測試 |
| [P2] Lock protocol 細節未定（realpath、compromise、first-create） | accept | DEC-003 補完整 lock protocol |
| [P2] CLI invocation / stream / exit-code 契約未保留 | accept | REQ-006 補 synopsis 與 I/O 契約；Verification 改測 `seat usage --json` |
| [P2] 上游 pi-accounts 非 per-turn sync，照搬會騎舊 credential | accept | Technical approach 明訂 turn_start 完整流程 + two-turn test |
| [P2] Rollback 誤把「legacy 未動」當「legacy 可用」 | accept | Rollback 步驟改寫，明載 rotated token 需重新 login |
| [P3] Runtime override 是 Pi 私有 API | noted | Technical approach 記錄 0.84.2 compatibility + feature detection |
| [P3] NFR-001 benchmark protocol 未固定 | noted | 固定 hyperfine process-cold p95 |

無 ACCEPT-RISK；new-mechanism 收 2 項，於預算內。

### tasks.md round

tasks.md 由單一 critic lens（task-breakdown fidelity）審查，9 項 findings 全數 accept，無爭議項故省略 round 2。

| Finding | Disposition | Resolution |
|---|---|---|
| [P1] T001 在無 TS input 時要求 typecheck（false-green 風險） | accept | T001 改驗 install + manifest/scripts 存在；首次 typecheck 移至 T003 |
| [P1] T004 的 Verify 不執行 helper（Bun 實測 exit 1） | accept（new-mechanism 1/2） | 新增 auth-snapshot.test.ts 自測 + bunfig preload 強制 integration tests 套用 |
| [P1] AC-004 放在 extension 尚不存在的 selector unit test | accept | T013 留 parser matrix；新增 T030 於 extension 載入後做 startup fail-closed integration |
| [P1] ModelRuntime 存取路徑與測試 seam 未釘死 | accept | T015 釘 `ctx.modelRegistry.runtime` structural cast；T008 釘 refresh-callback DI；T009 ephemeral HTTP server + child processes；T016 fake runtime 計數 stream |
| [P1] T019 smoke false-green 且會在 cutover 前觸發 live migration | accept | smoke 改 sandbox `PI_CODING_AGENT_DIR` + RPC mode，pass signal = sandbox migration side effect，live 檔 byte-identical 斷言；新增全局 sandbox rule |
| [P1] T022 無 runnable Verify、fixture contract 未定義 | accept | 釘單一 python-golden.json schema（scenario→width→lines）與 cmp 驗證；T025 補三種 TS-native scenarios |
| [P1] Command tasks 過大、CLI contract 測試缺口 | accept | T020 縮為 shared mutation handlers；新增 T031（handler tests）、T032（extension adapter）；T028 擴為全 synopsis matrix + exit 0/1/2 |
| [P2] 三個 normative branch 無 correctness signal | accept | T009 補 timeout-keeps-store；T016 補 transient recovery + invalid_grant 持續阻擋；T011 補 existing-store/legacy-absent no-op + notice |
| [P3] Traceability refs 不完整、bench script 雙重責任 | accept | 補齊 T014/T019/T027 refs；bench script 歸 T029 單一責任 |

## Related

- [requirements.md](./requirements.md) ← Behavioral requirements and acceptance criteria
