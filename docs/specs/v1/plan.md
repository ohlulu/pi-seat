# pi-seat v1 — Plan

## Technical approach

- 單一 TS monorepo（bun + TypeScript）：`src/store`、`src/usage` 為純模組，`src/extension` 與 `src/cli` 是兩個薄入口，共用前兩者。
- Credential lifecycle 層改作自 pi-accounts（MIT）：`storage.ts`（locked atomic store）、`runtime-auth.ts`（coordinator / overlay / fail-closed / verify）、`oauth.ts`（重用 Pi 內建 provider 的 login/refresh/toAuth）。改作而非依賴：要改 selection resolution（env pin）、store schema（aliases、seat 命名）與 UI 層（seat 習慣的指令集）。
- Selection resolution 是本專案唯一的新核心邏輯：`env pin > store default > Pi built-in`，pin 在 extension init 讀一次 `PI_SEAT`，天生 session-scoped。
- Usage 渲染自 Python seat 移植為純函式模組（`cells.ts`、`layout.ts`、`render.ts`），以 golden output 對照 Python 版驗證行為等價。
- Python seat 退役：`~/.pi/agent/bin/seat` 原路徑改為指向本 repo build 的 bun shim（dotfiles allowlist 路徑不變）。

## Decisions

### DEC-001: Adapt pi-accounts, not depend on or PR to it

- Choice: 把 pi-accounts 的 storage / runtime-auth / oauth 三層 vendor 進來改作，保留 MIT attribution。
- Alternatives: (a) 直接依賴 `@narumitw/pi-accounts` 並包一層；(b) 上游 PR 加 env pin。
- Rationale: (a) 它的 store schema、`/accounts` UI 與全域 `active` 都不符需求，包一層要對抗的比重寫的多；(b) env pin 或許可上游，但 seat 命名、aliases、CLI、usage 完全是本地需求。改作讓我們擁有整條 credential 路徑。上游修 bug 時手動 cherry-pick。
- Satisfies: REQ-001, REQ-004, REQ-005。

### DEC-002: Selection resolution — env pin 讀一次，不追蹤變化

- Choice: extension init 時解析 `PI_SEAT` 存為 immutable session pin；`/seat use` 在有 pin 的 session 裡拒絕並提示（pin 優先權最高，改 default 對本 session 無效，靜默接受只會誤導）。
- Alternatives: 每 turn 重讀 env（無意義，env 不會變）；pin session 內允許 use 並暫時覆蓋（引入第三種 selection 狀態，複雜度不值）。
- Satisfies: REQ-002, REQ-003。

### DEC-003: Store schema v1

- Choice: 單檔 `seat.json`：`{ version: 1, providers: { <id>: { default?: label, profiles: { label: credential }, aliases: { alias: label } } } }`。own-property 存取（label 是使用者輸入，防 `__proto__`）、0600、O_NOFOLLOW、atomic rename、proper-lockfile（與 Pi 同一套 lock 函式庫，但鎖自己的檔案）。
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

- Choice: repo 常駐 `~/Developer/ohlulu/pi-seat`；Pi 以 local package path 載入 extension（`~/.pi/agent/settings.json` packages 條目）；CLI shim 覆蓋 `~/.pi/agent/bin/seat`（路徑不變，dotfiles `gg_add_allowlist` 無需改動）。不發 npm。
- Alternatives: 發 npm 走 `pi install`（個人工具，發佈成本無收益）。

## Change Map

| File | Action | Satisfies |
|---|---|---|
| `src/store/schema.ts` | create — schema v1 types + parse/validate（own-property） | REQ-001 |
| `src/store/storage.ts` | create — 改作 pi-accounts storage.ts：lock、0600、O_NOFOLLOW、atomic write | REQ-001, REQ-005 |
| `src/store/refresh.ts` | create — locked single-flight refresh（extension 與 CLI 共用） | REQ-005 |
| `src/store/migrate.ts` | create — claude-profiles.json 匯入（排除 auth.json byte-identical） | REQ-008 |
| `src/extension/index.ts` | create — extension 入口：pin 解析、per-turn sync、`/seat` 指令 | REQ-002, REQ-003 |
| `src/extension/runtime-auth.ts` | create — 改作 pi-accounts：coordinator、overlay、fail-closed、verify、codex invalidation | REQ-004, REQ-009 |
| `src/extension/oauth.ts` | create — 改作 pi-accounts：anthropic + openai-codex adapters（重用 Pi 內建 OAuth） | REQ-007 |
| `src/extension/commands.ts` | create — `/seat` 子指令：login/use/rm/rename/status + shorthand + aliases | REQ-003, REQ-007 |
| `src/usage/cells.ts` | create — cell_width / cell_clip / fit 移植 | REQ-006 |
| `src/usage/layout.ts` | create — layout tiers 移植 | REQ-006 |
| `src/usage/render.ts` | create — bars / account blocks / spinner 移植 | REQ-006 |
| `src/usage/fetch.ts` | create — Claude oauth/usage 與 Codex wham/usage endpoints（沿用 Python 版 headers） | REQ-006 |
| `src/cli/main.ts` | create — CLI 入口：usage(default)/use/status/whoami/rm/rename/--plain/--json | REQ-003, REQ-006 |
| `test/**` | create — 見 Verification | all |
| `~/.pi/agent/settings.json` | edit — packages 加 local path（dotfiles repo） | DEC-006 |
| `~/.pi/agent/bin/seat` | replace — Python 檔換 bun shim（dotfiles repo，路徑不變） | DEC-006 |

## Verification

- Unit（bun test）：store schema/lock/atomic write、single-flight refresh（並發模擬，AC-009）、selection resolution（pin/default/builtin 矩陣）、migration（AC-014）、cells/layout golden 對照（自 Python 版產生 fixture，AC-011 的 2–200 寬度掃描）。
- Extension smoke（真實 Pi）：`pi -ne -e ./src/extension/index.ts` 確認 tool list 不消失；tmux 驅動 TUI 驗證 `/seat` 指令；兩個 pinned session 並行驗證 AC-003。
- Fail-closed（AC-004/007/008）：以假 adapter 注入 refresh/verify 失敗，斷言 turn 中止與 sentinel。
- CLI：`hyperfine 'seat status --plain'` 驗 NFR-001；`seat --json` schema 對照。
- 全程 `auth.json` byte-identical 斷言（AC-001）掛在每個整合測試的 teardown。

## Migration / rollout

1. repo 完成、測試綠 → settings.json 掛上 extension（Python seat 尚在，兩者不衝突：extension 不碰 auth.json）。
2. `/seat login` 逐帳號建立新 grant（或吃 REQ-008 自動匯入的 dormant profiles）。
3. 驗證雙 session pin 工作流跑順一週。
4. 替換 `bin/seat` 為 TS CLI，Python 版移入 repo 的 `legacy/` 留檔。
5. 需要 rollback 時：settings.json 移除 package、還原 Python bin/seat（git revert dotfiles），claude-profiles.json 從未被動過。

## Open questions

無 — usage surface（TS monorepo）、provider 範圍（anthropic + codex）、切換語意（use 寫 global default）、repo 名稱已由使用者拍板。
