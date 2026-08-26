---
summary: pi-seat architecture — module layout, per-turn overlay lifecycle, Pi compatibility surface, and technical decisions; DEC ids are the stable anchors cited by src and test
read_when:
  - Implementing any pi-seat module or deciding where new code lives
  - Changing the store lock protocol, refresh path, runtime overlay, or CLI runtime
  - Resolving a DEC-### id cited in code or tests
---

# pi-seat — Architecture

Id policy：`DEC-###` 是被 `src/` 與 `test/` 直接引用的 stable anchors — append-only，永不 renumber。行為契約（REQ / AC）在 [specs/behavior.md §Summary](./specs/behavior.md#summary)。

## Module layout

單一 TS monorepo（bun + TypeScript）：`src/store`、`src/usage` 為純模組，`src/extension` 與 `src/cli` 是兩個薄入口，共用前兩者。credential lifecycle 層（`storage.ts`、`runtime-auth.ts`、`oauth.ts`）改作自 pi-accounts（MIT，attribution 見 NOTICE）。

## Per-turn overlay lifecycle

Pi 一次 agent loop 可有多個 turn，tool continuation 可能騎在過期或已切換的 credential 上——只在 `before_agent_start` sync（上游 pi-accounts 的做法）不滿足 [REQ-004](./specs/behavior.md#req-004-fail-closed-runtime-application)。本專案的 async `turn_start` handler 每個 turn 執行 selection → locked refresh → toAuth → overlay → verify；任一步失敗（含 sentinel 安裝自身）先無條件 `ctx.abort()`，再 best-effort 安裝 sentinel。

Selection resolution 是本專案唯一的新核心邏輯：`env pin > store default > Pi built-in`，pin（含 alias→label 解析）在 extension init 讀一次 `PI_SEAT`，天生 session-scoped。

## Pi compatibility

Runtime overlay 依賴 Pi 內部 `ModelRuntime.setRuntimeApiKey/removeRuntimeApiKey`（非公開 ExtensionAPI）：以 structural cast 從 `ctx.modelRegistry.runtime` 取得 active runtime，startup 做 feature detection，缺失時 fail-closed 並提示版本不相容。Pi upgrade 是已知 residual risk——private API 無相容性保證。

## Decisions

### DEC-001: Adapt pi-accounts, not depend on or PR to it

- Choice: 把 pi-accounts 的 storage / runtime-auth / oauth 三層 vendor 進來改作，保留 MIT attribution。
- Alternatives: (a) 直接依賴 `@narumitw/pi-accounts` 並包一層；(b) 上游 PR 加 env pin。
- Rationale: (a) 它的 store schema、`/accounts` UI 與全域 `active` 都不符需求，包一層要對抗的比重寫的多；(b) env pin 或許可上游，但 seat 命名、aliases、CLI、usage 完全是本地需求。改作讓我們擁有整條 credential 路徑。上游修 bug 時手動 cherry-pick。
- Satisfies: REQ-001, REQ-004, REQ-005。

### DEC-002: Selection resolution — env pin 讀一次；`use` 一律持久化

- Choice: extension init 時解析 `PI_SEAT`（含 alias→label，一次解析不重解析）存為 immutable session pin。`/seat use` 在任何 session 都寫入 global default；目標 provider 有 pin 時照樣寫入，並提示「default 已更新，本 session 維持 pin」；未 pinned 的 provider 立即套用新 default。
- Alternatives: 每 turn 重讀 env 或重解析 alias（mid-session rename 會靜默 retarget 既有 pin，違反 pin 的 immutability；dangling 情況由 per-turn profile lookup 的 fail-closed 涵蓋）；pinned session 拒絕 `use`（違反「use 寫 global default」的語意，且擋住在 Codex pin 下更新 Anthropic default）。
- Satisfies: REQ-002, REQ-003。

### DEC-003: Store schema v1 與 lock protocol

- Choice: 單檔 `seat.json`：`{ version: 1, providers: { <id>: { default?: label, profiles: { label: credential }, aliases: { alias: label } } } }`。own-property 存取（label 是使用者輸入，防 `__proto__`）、0600、O_NOFOLLOW、atomic rename、`proper-lockfile`（與 Pi 同一套 lock 函式庫，但鎖自己的檔案）。
- Alternatives: 沿用 claude-profiles.json 格式（無 provider 維度、identities 欄位已無用途）。
- Satisfies: REQ-001, REQ-005, REQ-007。

Lock protocol（所有 process 必須一致；實作在 `src/store/storage.ts`）：

- `realpath: false`（預設 `realpath: true` 在 target 不存在時 ENOENT，first-create 會炸；Pi 自身的 auth-storage 同樣設定）。
- 統一 `stale` / `update` 參數與 lock path，sync 與 async 路徑共用同一組常數。
- Mutator 在取得 lock 後對 lock 內讀到的內容重查條件（lock 內 re-check）。
- Temp file 以 0600 / O_EXCL 建於 `dirname(seat.json)`，同 volume rename 完成 atomic write；讀取端 O_NOFOLLOW 並拒絕非 regular file。
- Foreign files（`auth.json` 等非本專案所有的檔案）走獨立的 no-lock、no-chmod、O_NOFOLLOW 唯讀快照，永不寫入。

Ownership fencing——lock compromised 後禁止 commit，失鎖狀態下寫入會覆蓋另一 process 的 rotated credential。fence 的證據與位置：

- 取得 lock 時對 lock directory 開一個 `O_DIRECTORY | O_NOFOLLOW` fd 並記錄其 `(dev, ino)`。持有的 fd 讓 kernel 保住這顆 inode，後繼者重建的 lock 不可能拿到同一顆——單純快照 inode 號碼的做法會被 inode-recycling filesystem（ext4/tmpfs）擊敗；APFS 從不回收，所以那種 fence 只在 Linux 上失效。
- Commit 就是 rename，所以 ownership 在 `renameSync` 前一刻重驗，而不是在更早的 temp-file 寫入前——寫入中被暫停的 writer 正是 takeover 要競爭的對象。驗證 = fd 的 `nlink == 0` 檢查（filesystem 有回報移除時的直接訊號）加上 lock path 的 `lstat` 與記錄的 `(dev, ino)` 比對（跨 filesystem 的守門）。ownership 無法證明即視為已失去，commit 拒絕。
- Release 同樣 ownership-aware：lock 已不是我們的時，跳過目錄移除，只清掉 proper-lockfile 的 bookkeeping（它的 exit handler 會 rmdir 每個仍註冊的 lock，否則一個拒絕 commit 的 process 退出時會刪掉後繼者的 lock，讓第三個 writer 在其 commit 中途進場）。
- Lock directory 必須保持空——proper-lockfile 以 non-recursive rmdir release，任何內容物都會 ENOTEMPTY 並讓之後所有 writer deadlock。

### DEC-004: CLI runtime 與 width 計算

- Choice: CLI 以 bun 直跑 TS（shim: `#!/usr/bin/env bun`）；cell width 自行移植 Python 的 `cell_width`（East Asian W/F = 2，Ambiguous = 1，約 30 行 + 對照測試），不引入 string-width 或 pi-tui 依賴。
- Rationale: NFR-001 的啟動預算容不下重依賴；Ambiguous=1 的行為必須與 Python 版完全一致，第三方套件對 Ambiguous 的處理不受控。
- Satisfies: REQ-006, NFR-001。

### DEC-005: CLI 對 store credential 有 refresh 權，對 auth.json 沒有

- Choice: CLI 的 usage 流程對過期 store credential 走 REQ-005 的 locked refresh；auth.json 的內建登入 credential 一律不碰（讀都用唯讀快照，過期只提示）。
- Rationale: store grant 是我們獨佔的，refresh 安全；auth.json 的 grant 是 Pi 的，動它就回到 Python seat 的整套 attribution 地獄。
- Satisfies: REQ-005, REQ-006。

### DEC-006: 部署形態

- Choice: repo 常駐 `~/Developer/ohlulu/pi-seat`；本機 dogfooding 以 local package path 載入（settings.json packages 條目 + working-tree CLI shim）；對外發佈 npm `pi-seat`（`pi install npm:pi-seat` + `bun add -g pi-seat`），Pi 套件以 peerDependencies `*` 由 pi runtime 提供（同 pi-accounts pattern）。發佈程序見 [RELEASING.md](./RELEASING.md)。
- History: 原判斷「不發 npm（個人工具，發佈成本無收益）」，後由使用者拍板改為發佈。

### DEC-007: In-session usage view 復用 usage 純模組

- Choice: `/seat`（無參數）、`/seat status` 與 `/seat usage` 在 TUI 開 `ctx.ui.custom()` component（`src/extension/usage-view.ts`），直接吃 `src/usage` 的 cells/layout/render 輸出；`esc`/`q` 關閉。非 TUI（`ctx.mode !== "tui"`，不用 `hasUI`）退回文字。
- 守則（來自 pi.md 實證 gotchas）：spinner 重繪必須回傳 `dispose`；view 開啟中不另開 nested UI；寬度安全走既有 `fit`/`cell_clip`，並以 render probe 掃 width 2–200 驗證無 row 溢出（含固定 chrome 字串）。
- Alternatives: statusbar 常駐元件（資訊密度不夠，且佔永久螢幕空間）。
- Satisfies: REQ-010。

### DEC-008: Report chrome 由一個 stateful row assembler 產出

- Choice: provider section header 與帳號 block 的組裝集中在 `src/usage/report.ts` 的 `UsageReportRows`：`account()` 回傳一個帳號的列，順手補上它所開啟 section 的 header；`rest()` 補上沒有任何帳號開啟的 section。
- Rationale: 兩個呼叫端的形狀不同——CLI 邊拿到邊印，沒辦法往前看哪一個帳號開啟了 section；view 每次 render 都拿到完整陣列。純函數只能服務後者，兩邊各自追蹤 “上一個 provider” 則是兩份會漂移的狀態機。一個只往前走的 cursor 兩者都能用：CLI 建一個並串流到底，view 每次 `buildRows` 建一個並一次走完（`buildRows` 本來就被 width cache 包著）。
- Section 本身（`usageSections`）是 store snapshot 的純函數，與 fetch 路徑脫鉤：view 能在第一幀就畫出 header，且無帳號可測的 provider 不會因為沒有 account event 而消失。
- Ordering 排在 walk 而不是輸出：`collectUsage` 先跑 effective selection，所以它也是第一個發出請求、第一個畫上畫面的帳號。
- 寬度：section title 與 rule 是 DEC-007 口徑中的 “constant chrome”，rule 以 `layout.width - 1` 產生並走同一條 `emitLine` 剪裁；render probe 的 2–200 掃描涵蓋它們。
- Satisfies: REQ-006, REQ-010。

### DEC-009: Selection gutter 全數帳號均攝；liveness 改為衍生

- Choice: view 的選取標記是左側 2 欄 gutter（選取畫 `▌` + cyan，其餘留空），**所有**帳號列都攝這 2 欄；section header 不攝。帳號列以 `planLayout(width - cells)` 排版，標記才能安全前置。
- Alternatives: （a）真的外框（左右各 2 欄）；（b）只把選取列反白、不加 gutter。
- Rationale: Pi 自己的 `SelectList`（`docs/tui.md` Pattern 1）用 `selectedPrefix` + accent，`DynamicBorder` 框的是整個 dialog 而非單項——gutter 才是 host 的語彙。橫向代價也實量過：`planLayout` 的 tier 邊界在 60 / 43 / 38，2 欄把它們推到 62 / 45 / 40（AC-011b 的 ≥ 40 保證對應 `planLayout(38)`，仍在安全側），外框的 4 欄則不劃算。只給選取列 gutter 是錯的：游標一移，整片 bar 就左右跳。方案（b）零成本但單靠顏色傳達選取，單色終端失效。
- `UsageAccount.live` 隨之移除，改為 `isLive(sections, account)` 在 render 時推導。View 能在 meters 已在螢幕上時改寫 default，而 fetch 時凍結的 flag 會讓點留在剛切走的帳號上直到整份重拿。順帶修正一個 `--json` 邊界：`active` 現在報 selection 所**命名**的 label，而非「有回應的那個」——dangling default 下回 null 會被讀成「built-in 生效」，但 runtime 實際是 fail-closed。
- Ordering 不在切換後重排：重排會把區塊從游標底下抽走。與 DEC-008 的「ordering 是 walk 的決定」一致：順序屬於那一次 walk，下一次 refresh 才收斂。
- 範圍停在 `use`：`rm` / `login` 需要巳狀 UI，而漏帶 `{ overlay: true }` 的巳狀 `ctx.ui.custom()` 會讓 base component 的 promise 永不 resolve（pi.md 實證 gotcha，無法從 session 內救回）。
- Satisfies: REQ-010。

### DEC-010: Key 辨識一律走 pi-tui 的 `matchesKey`

- Choice: view 的所有按鍵判定（esc / q / ↑ / ↓ / j / k / enter / r）呈給 `@earendil-works/pi-tui` 的 `matchesKey` 與 `Key`，不自己比對 escape sequence 字串。pi-tui 因此進入 peerDependencies / devDependencies（同 DEC-006 的 Pi 套件 pattern，由 pi runtime 提供）。
- Rationale: Pi 在啟動時以 flags `1|2|4` 協商 Kitty keyboard protocol（pi-tui `Terminal.queryAndEnableKittyProtocol`）。協商成功的終端上，esc 以 `esc [ 27 u` 抵達、enter 以 `esc [ 13 u` 抵達，且 `\n` 不再是 enter 而是 shift+enter。手寫的 `data === "\x1b"` 在這些終端上全數失效，`matchesKey` 則同時涵蓋 legacy、application-cursor、modifyOtherKeys 與 CSI-u。
- 這是一條 smoke 節目上的盲點：tmux 不協商 Kitty protocol，所以 `scripts/smoke-usage-view.sh` 無論如何都是綠的。覆蓋靠的是 `usage-view.test.ts` 裡對兩種 encoding 都斷言的 regression test（以 `setKittyProtocolActive` 切換）。
- Satisfies: REQ-010。

## Related

- [specs/behavior.md §Store](./specs/behavior.md#store) ← store、refresh、login 的行為契約（DEC-001/003/005 的 Satisfies 對象）
- [specs/behavior.md §Selection & runtime](./specs/behavior.md#selection--runtime) ← pin、default、fail-closed overlay、Codex invalidation 的行為契約（DEC-002 與 per-turn lifecycle）
- [specs/behavior.md §Usage](./specs/behavior.md#usage) ← usage CLI 與 in-session view 的行為契約（DEC-004/007/008/009/010）
- [RELEASING.md §Facts](./RELEASING.md#facts) ← DEC-006 部署形態對應的發佈 facts 與程序
