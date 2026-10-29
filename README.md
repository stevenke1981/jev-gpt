# jev-gpt — 單一 GPT 模型、Jev 決定 effort、長任務續跑

> 只用一個模型（預設 GPT-6.1 Terra），每次 generation 由 Jev 在 low～xhigh 之間決定 reasoning effort，
> 並在模型「話說到一半就收工」時把任務接回來做完。

本專案衍生自 [jev-sol-terra](https://github.com/stevenke1981/jev-sol-terra)（615dac7）。差異：

| | jev-sol-terra | jev-gpt |
|---|---|---|
| 模型 | Terra／Sol 逐代切換 | 只用 `gpt-6.1-terra`（`JEV_GPT_MODEL` 可改） |
| effort | low～xhigh | low～xhigh，**新 turn 預設 medium** |
| 長任務 | — | 計畫提醒（nudge）＋提早收工自動續跑（resume） |
| 預設埠／home／Codex profile | 8788／`~/.jev-sol-terra`／`jevst` | **8789**／`~/.jev-gpt`／`jevgpt` |

三者（jev-effort、jev-sol-terra、jev-gpt）可同時執行。

## Effort 如何決定

proxy 位於 Codex（或 Chat Completions 客戶端）與上游之間，每次 generation 前讀取本輪軌跡（工具呼叫與成敗），決定 effort：

- **新 turn**：預設 `medium`（`JEV_DEFAULT_EFFORT`）。招呼語 → `low`；困難程式（設計、重構、除錯、根因…）、深入問題（原理、分析、比較…）或超過 600 字的需求 → 預設再高一階（`high`）。
- **turn 中**：讀檔、列目錄、建置成功等例行步驟 → `low`；剛改完程式、累積多次讀檔待綜合 → `medium`；連續失敗、重複同一個失敗指令 → 升到 `high`／`xhigh`，並鎖定數步；恢復成功後逐級回落。
- **jev 模式（有 `OPENROUTER_API_KEY` 時預設）**：由 OpenRouter 上的 [`typesafe/jev-1.14`](https://openrouter.ai/typesafe/jev-1.14) 以 Decisions API 回答 `effort`（score）與 `stuck`（noul）。新 turn 送出的 `current_effort` 為預設 effort。信心不足、逾時或錯誤時改用本地規則，不擋住客戶端。
- 一旦本輪被續跑過（見下節），之後的 effort 不低於預設值：低 effort 正是模型偷懶收工的地方。

改寫範圍：只改 effort（Responses 的 `reasoning.effort`；Chat 的 `reasoning_effort` 或 `reasoning.effort`），客戶端 model 為 `jev-auto`／`auto` 時另把 `model` 改成設定的模型 id（OpenRouter 上為 `openai/gpt-6.1-terra`）。`instructions`、`tools` 與既有 `input` 不變，prompt cache 前綴維持命中；長任務協助只在**請求末端**附加訊息。

## 長任務協助

GPT-6.1 Terra 在長任務中常提早結束 turn：寫個摘要、說「接下來我會…」、或問「要我繼續嗎？」，但工作其實沒做完。jev-gpt 用兩種方式協助：

### 1. 計畫提醒（nudge，`JEV_NUDGE=on`）

若本輪 agent 的計畫還有未完成步驟，每次 generation 前在請求末端附加一則提醒（Responses 為 `developer` 訊息，Chat 為 `system` 訊息）：已完成幾步、還剩哪些步驟、全部做完並驗證前不要收工、不要停下來問是否繼續。

提醒與續跑都只作用於「被路由」的請求（帶 `reasoning` 或 model 為 `jev-auto`／`auto`），`JEV_MODE=off`（純轉送）時兩者皆關閉。續跑請求不另加新提醒，但原請求裡的提醒仍在歷史中。

計畫來源：Codex 的 `update_plan` 工具（`plan[].step/status`，Responses 與 Chat 皆讀）；opencode 類的 `todowrite`／`TodoWrite`（`todos[].content/status`）只在 Chat 路徑讀取。

### 2. 提早收工自動續跑（resume，`JEV_CONTINUE=on`）

適用於串流的 Responses 請求（Codex）。proxy 暫扣上游最後的 `response.completed` 事件，判斷這一代是否「結束了 turn 但工作未完成」：

1. 這一代的輸出沒有任何工具呼叫（即模型要把控制權交還使用者）；
2. 本輪至少做過一個工具步驟或有計畫（純問答從不續跑）；
3. 本輪續跑次數未達 `JEV_MAX_CONTINUES`（預設 3）；
4. 停止判斷的 `unfinished` ≥ `JEV_CONTINUE_THRESHOLD`（預設 0.6）。

全部成立時，proxy 立刻再送一個請求給上游：原請求＋剛才的輸出＋一則 `[jev]` developer 訊息（「你結束了 turn 但任務未完成，現在繼續…」），effort 提高一階（至少為預設值）。新回應的事件接在同一條串流上送回 Codex（不重送 `response.created`），所以 Codex 看到的是同一個 turn 繼續工作。不續跑時，暫扣的事件原樣放行。

停止判斷：

| 模式 | 判斷方式 |
|---|---|
| jev | Jev Decisions API 問 `unfinished`（noul）：「agent 剛結束 turn，是否在不需使用者輸入的情況下提早停了？」state 含本輪軌跡、最後訊息（前 2000 字）與計畫。失敗時改用規則 |
| heuristic／llm | 規則（先命中者優先）：沒做事 0；向使用者索取資訊（your API key、please provide/confirm、請提供、請先登入、哪一個…）0.1；計畫有未完成步驟 0.9；直接問句徵求許可（would you like me to…?、shall I…?、要我…嗎）或第一人稱預告（next I'll、I still need to、接下來我會、尚未完成）0.75；最後一步失敗 0.5；其餘 0.1。「if you want me to…, let me know」、「下一步建議…」、「TODO」這類收尾語不觸發續跑 |
| off | 不續跑 |

終端機輸出範例：

```
Jev  MEDIUM → LOW  ✓ APPLIED
     Step 6 · next 1 generation(s) · 512 ms · jev score 0.12 (conf 0.95), stuck 0.04
Jev  RESUME #1 → HIGH  ✓ APPLIED
     Step 6 · unfinished 0.88 · jev · jev unfinished 0.88
```

## 安裝與使用

需求：Node.js ≥ 22.15（零依賴）、Codex CLI，或任一 Chat Completions 客戶端。

```powershell
git clone https://github.com/stevenke1981/jev-gpt.git
cd jev-gpt                 # 一定要在這個資料夾執行 npm link
npm link                   # 註冊全域指令 jev-gpt（或直接 node bin/jev.js ...）
jev-gpt --version
Copy-Item .env.example .env.local   # 填入 OPENROUTER_API_KEY（見「API keys / 金鑰設定」）
jev-gpt install            # 寫入 $CODEX_HOME/jevgpt.config.toml（預設 ~/.codex）
```

`install` 寫入的 Codex profile：`model = "gpt-6.1-terra"`、`model_reasoning_effort = "medium"`、`jevgpt` provider 指向 `http://127.0.0.1:8789/v1`、`wire_api = "responses"`、`requires_openai_auth = true`（沿用 Codex 既有登入；`--provider openai|openrouter` 改為 `env_key`，見「API keys / 金鑰設定」）。檔案若存在且不是本工具寫入的，會拒絕覆寫，需加 `--force`。

```powershell
# A. 一鍵：背景啟動 proxy，再執行 codex -p jevgpt
jev-gpt codex
jev-gpt codex exec "implement the plan in TODO.md and make the tests pass"

# B. 即時看決策：開兩個視窗
jev-gpt serve              # 視窗 1
codex -p jevgpt            # 視窗 2
```

| 指令 | 用途 |
|---|---|
| `jev-gpt serve` | 前景執行 proxy（預設 `127.0.0.1:8789`） |
| `jev-gpt install [--force]` | 寫入 `jevgpt` profile |
| `jev-gpt codex [args...]` | 必要時啟動 proxy，再執行 `codex -p jevgpt [args...]` |
| `jev-gpt tail` | 即時追蹤決策（讀 `decisions.jsonl`） |
| `jev-gpt stats` | 依 effort 分組統計 generation、reasoning tokens 與續跑次數 |
| `jev-gpt status` | 顯示執行中 proxy 的版本；過舊或未執行時 exit 1 |
| `jev-gpt stop` | 停止執行中的 proxy（只停 `app` 為 `jev-gpt` 者） |
| `jev-gpt --version` | 磁碟上程式碼的版本與 build |

**更新後請重啟 proxy**（`git pull` 後 `jev-gpt stop`）。`/jev/health` 回報 `app`、`version`、`build`、`pid`、`startedAt`、`mode`、`ladder` 與 `stats`（含 `byEffort`、`continued`、`nudged`；`continued` 只計成功送出的續跑，續跑上限則以嘗試次數計）。`decisions.jsonl` 每筆另有 `nudged: true` 與 `continues: [{n, effort, unfinished, source, reasons}]`（有發生時）。

**上游與憑證**：`JEV_UPSTREAM` 強制指定；ChatGPT 登入（JWT 或 `chatgpt-account-id`）→ `chatgpt.com/backend-api/codex`；`sk-or-` 金鑰 → `openrouter.ai/api/v1`；其他 → `api.openai.com/v1`。proxy 不寫入任何憑證到記錄。

## Chat Completions 客戶端

proxy 也代理 `POST /v1/chat/completions`。opencode、aider、crush 把 base URL 指到 `http://127.0.0.1:8789/v1`，model 設 `jev-auto`。effort 路由與計畫提醒都適用；**自動續跑目前只支援 Responses 串流**（Codex），Chat 客戶端不續跑。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "jev": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "jev-gpt (OpenRouter)",
      "options": { "baseURL": "http://127.0.0.1:8789/v1", "apiKey": "{env:OPENROUTER_API_KEY}" },
      "models": { "jev-auto": { "name": "GPT-6.1 Terra (Jev effort)" } }
    }
  }
}
```

```powershell
$env:OPENAI_API_KEY = $env:OPENROUTER_API_KEY
aider --openai-api-base http://127.0.0.1:8789/v1 --model openai/jev-auto
```

## API keys / 金鑰設定

| 金鑰 | 用途 | 何時需要 |
|---|---|---|
| `OPENROUTER_API_KEY` | Jev 決策（OpenRouter 上的 `typesafe/jev-1.14`），依呼叫計費；`install --provider openrouter` 時也是主模型的金鑰 | 要用 Jev 決定 effort 時必填；沒有它則 `JEV_MODE` 預設為 `heuristic` |
| `OPENAI_API_KEY` | `install --provider openai` 時，主模型走 OpenAI API 的金鑰 | 只有選 openai 時需要 |

`install --provider` 決定 Codex 如何替主模型驗證（寫入 `$CODEX_HOME/jevgpt.config.toml` 的 provider 表）：

| `--provider` | profile 寫入 | 主模型去向 |
|---|---|---|
| `chatgpt`（預設） | `requires_openai_auth = true` | Codex 的 ChatGPT 登入 → `chatgpt.com/backend-api/codex` |
| `openai` | `env_key = "OPENAI_API_KEY"` | Codex 送出 `sk-` 金鑰 → `api.openai.com/v1` |
| `openrouter` | `env_key = "OPENROUTER_API_KEY"` | Codex 送出 `sk-or-` 金鑰 → OpenRouter，模型 id 改為 `openai/<id>` |

### 三種設定方式

1. **系統環境變數**（開新終端機後生效）：

   ```powershell
   [Environment]::SetEnvironmentVariable('OPENROUTER_API_KEY', 'sk-or-...', 'User')
   ```

   ```bash
   export OPENROUTER_API_KEY=sk-or-...   # 寫進 ~/.bashrc 或 ~/.zshrc 才會保留
   ```

2. **專案的 `.env.local`**：

   ```powershell
   Copy-Item .env.example .env.local   # bash: cp .env.example .env.local
   ```

   再編輯 `.env.local` 填入金鑰。`.env`、`.env.local` 已列在 `.gitignore`，**不要 commit**。

3. **全域安裝（npm link）的 `~/.jev-gpt/.env.local`**（`JEV_HOME` 可改位置）。

### 優先順序

1. 已設定的系統或 shell 環境變數（非空字串）優先，檔案不會覆蓋它。
2. 專案資料夾的 `.env.local`，再 `.env`。
3. `JEV_HOME`（預設 `~/.jev-gpt`）的 `.env.local`，再 `.env`。

同一變數先找到者勝出。只讀取 `JEV_*`、`OPENAI_*`、`OPENROUTER_*` 變數，共用 `.env` 裡的其他秘密不會傳給 `codex`。檔案開頭的 UTF-8 BOM 會被忽略；檔案存在但讀不到時只顯示警告。`serve` 啟動時列出載入的檔案與變數名稱（不印出值）。

注意：`jev-gpt codex` 啟動的 Codex 會繼承從 `.env.local` 讀到的金鑰；直接執行 `codex -p jevgpt` 或使用 Codex 桌面版時，`--provider openai`／`openrouter` 需要的金鑰必須設在系統環境變數。

## 設定（環境變數）

| 變數 | 預設 | 說明 |
|---|---|---|
| `JEV_PORT` / `JEV_HOST` | `8789` / `127.0.0.1` | 監聽位址 |
| `JEV_GPT_MODEL` | `gpt-6.1-terra` | 唯一的上游模型 id |
| `JEV_AUTO_MODELS` | `jev-auto,auto` | 會改寫成上述 id 的客戶端 model 名稱 |
| `JEV_LEVELS` | `low,medium,high,xhigh` | effort 階梯 |
| `JEV_DEFAULT_EFFORT` | `medium` | 新 turn 起點，也是續跑後的下限；須在階梯內 |
| `JEV_MODE` | 有 `OPENROUTER_API_KEY` 時 `jev`，否則 `heuristic` | `jev`、`heuristic`、`llm`（小模型判官）、`off`（純轉送） |
| `JEV_CONTINUE` | `on` | 提早收工自動續跑 |
| `JEV_MAX_CONTINUES` | `3` | 每個 turn 最多續跑次數 |
| `JEV_CONTINUE_THRESHOLD` | `0.6` | `unfinished` 達此值才續跑 |
| `JEV_NUDGE` | `on` | 計畫有未完成步驟時附加提醒 |
| `OPENROUTER_API_KEY` | — | `jev` 模式必填；`--provider openrouter` 時也是主模型的金鑰 |
| `OPENAI_API_KEY` | — | `--provider openai` 時主模型的金鑰 |
| `JEV_PROVIDER` | `chatgpt` | `install` 寫入的驗證方式：`chatgpt`、`openai`、`openrouter`（同 `--provider`） |
| `JEV_DECISION_MODEL` / `JEV_DECISION_URL` | `typesafe/jev-1.14` / OpenRouter Decisions API | Jev 決策 |
| `JEV_MIN_CONFIDENCE` | `0.3` | Jev 信心低於此值改用規則 |
| `JEV_JUDGE_MODEL` / `JEV_JUDGE_EFFORT` / `JEV_JUDGE_TIMEOUT_MS` | 請求模型 / `low` / `2500` | `llm` 判官；逾時也套用到 Jev 決策 |
| `JEV_UPSTREAM`、`JEV_CHATGPT_UPSTREAM`、`JEV_API_UPSTREAM`、`JEV_OPENROUTER_UPSTREAM` | 依憑證 | 上游 |
| `JEV_HOME` | `~/.jev-gpt` | `decisions.jsonl`、`proxy.log` |
| `JEV_QUIET` | — | `1` 則不印決策 |
| `CODEX_HOME` | `~/.codex` | `install` 寫入目錄 |

## 架構

| 檔案 | 職責 |
|---|---|
| `src/config.js` | 環境變數與驗證 |
| `src/policy.js` | 規則判斷 `assess()`（預設 effort 起點）、hysteresis `nextState()` |
| `src/router.js` | 依 session 保存 effort 狀態與本輪續跑次數（`continuesOf`、`noteContinue`） |
| `src/decisions.js` | Jev 決策：`jevDecide()`（effort）、`jevStopCheck()`（是否提早收工） |
| `src/longtask.js` | 計畫解析 `turnPlan()`、`finalOutput()`、規則版停止判斷 `assessStop()`、提醒與續跑訊息 |
| `src/splice.js` | SSE 事件切分、暫扣 `response.completed`、把續跑回應接在同一串流 |
| `src/trajectory.js` / `src/chat.js` | Responses／Chat 軌跡解析 |
| `src/judge.js` | 選用的 LLM 判官 |
| `src/model.js` | 模型 id、`jev-auto` 別名、effort 對齊 |
| `src/proxy.js` | HTTP proxy：解壓、改寫、提醒、續跑、usage、`/jev/health` |
| `src/log.js` / `src/version.js` | 決策記錄與格式；版本與 build 指紋 |
| `bin/jev.js` | CLI |

## 限制與未驗證事項

- **未驗證**：Codex 以 ChatGPT 登入、對 `chatgpt.com/backend-api/codex` 的續跑串流尚未實測；Codex 是否完全接受「同一串流內第二個回應的事件」以本機模擬測試為準。
- 續跑請求重放上一代的輸出（去掉 `id`／`status`，比照 Codex 自己送回的格式）；reasoning item 只在帶 `encrypted_content` 或 summary 時重放。
- 回傳給客戶端的 `usage` 只含最後一個回應；續跑那一代的 tokens 也算在上游帳單裡。
- 規則版停止判斷是 regex 啟發式，可能誤判；每 turn 續跑上限與門檻可調，`JEV_CONTINUE=off` 可關閉。
- Chat Completions 不續跑；Codex 的 websocket 傳輸不經過 proxy。
- 省成本或完成率提升幅度請以 `jev-gpt stats` 於自身工作量量測。

## 測試

```powershell
npm test     # node --test；不連網路，上游以本機 http.createServer 模擬
```

## 變更歷史

| 版本 | 日期 | 內容 | 影響範圍 |
|------|------|------|----------|
| v0.1.0 | 2026-10-28 | 初始建立（衍生自 jev-sol-terra 615dac7）：單一模型 GPT-6.1 Terra、Jev 決定 low～xhigh effort（新 turn 預設 medium）、計畫提醒、提早收工自動續跑、CLI `jev-gpt`（埠 8789、profile `jevgpt`） | 全部 |
