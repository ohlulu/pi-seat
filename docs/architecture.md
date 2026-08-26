---
summary: pi-seat architecture — module layout, per-turn overlay lifecycle, Pi compatibility surface, and technical decisions; DEC ids are the stable anchors cited by src and test
read_when:
  - Implementing any pi-seat module or deciding where new code lives
  - Changing the store lock protocol, refresh path, runtime overlay, or CLI runtime
  - Resolving a DEC-### id cited in code or tests
---

# pi-seat — Architecture

Id policy：`DEC-###` 是被 `src/` 與 `test/` 直接引用的 stable anchors — append-only，永不 renumber。行為契約（REQ / AC）在 [specs/behavior.md](./specs/behavior.md)。

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

## Related

- [specs/behavior.md](./specs/behavior.md) ← 行為契約：每個 DEC 的 Satisfies 指向這裡的 REQ / AC
- [RELEASING.md](./RELEASING.md) ← DEC-006 部署形態的發佈程序
