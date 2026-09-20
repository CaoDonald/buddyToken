# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## 项目概述

buddyToken：把 AI 编码助手（WorkBuddy 桌面端 / CodeBuddy CLI）的积分账单与本机会话记录的 Token 消耗按回合对齐的本地看板。纯本地运行，**零 npm 依赖**——Node 脚本只用标准库，看板的 `xlsx` / `chart.js` 走 CDN。无构建、无测试、无 lint 步骤。

## 常用命令

```bash
node token-usage-report.js --emit-js              # 全量：扫本地会话 + 同步官方账单，生成看板数据（默认 7 天）
node token-usage-report.js --emit-js --light      # 省略每步明细，产物约小一半
node token-usage-report.js --emit-js --no-merge   # 关闭增量合并，纯全量覆盖
node token-usage-report.js --emit-js --only=credits  # 只刷官方账单/余额（需先跑过一次全量）
node token-usage-report.js --emit-js --only=tokens   # 只扫本地会话
node token-usage-report.js --emit-js --no-official    # 完全跳过官方同步（纯离线）
node token-usage-report.js --emit-js --official-days 30  # 官方拉取窗口（默认跟随 --days，兜底 7 天；账单还是空的时自动改拉全部历史约 3 年）
node token-usage-report.js --days 7 | --since 2026-09-01 | -o D:\out

node server.js          # 本地服务（127.0.0.1:8099，端口被占用自动 +1），提供 /api/sync 等
node server.js --no-open  # 启动但不自动打开看板
```

Windows 下 `同步Token.bat`（离线一键同步+打开看板）、`打开看板.bat`（起服务+打开看板）分别是两条主要入口。要求 Node 18+（用到 `util.parseArgs`）。

## 架构

五个模块，数据单向流动：**本地 jsonl + 官方接口 → token-usage-report.js → token-usage-data.js → 看板 HTML**。

- **`token-usage-report.js`** — CLI 主脚本。扫描 `~/.workbuddy/projects/**` 与 `~/.codebuddy/projects/**` 下的 `.jsonl` 会话记录（一条带 `message.usage` 的记录 = 一次 API 请求），产出 `token-usage-data.js`（`window.__TOKEN_DATA__ = {...}` 形式的 JS 文件，而非 JSON——因为 `file://` 下 fetch 不可用，看板靠动态注入 `<script>` 加载）、CSV 明细和 Markdown 汇总。`workbuddy-api.js` 加载失败时静默降级为纯本地扫描。
- **`workbuddy-api.js`** — 官方接口封装：从 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info` 发现账号凭证，拉积分账单、余额、套餐，及签到/猫猫旅行。**两个域不能混用**：账单在 `workbuddy.cn`，签到/活动在 `codebuddy.cn`。凭证只在内存使用，绝不写盘。另有账号库与切换：auth 目录的历史快照按 (uid, app) 分组即「可切换账号」——`workbuddy-desktop*.info` 属 WorkBuddy 桌面端、`Tencent-Cloud.coding-copilot*.info` 属 CodeBuddy CLI（归属已用 CLI 日志鉴权 uid 实证），切换 = 把目标快照整份写回该 app 的当前登录文件（原子写 + 备份到项目 `switch-backups/`，含 token 已 gitignore）；桌面端切换可选重启 WorkBuddy（exe 路径：进程路径→注册表→常见候选），IDE 登录态不在此目录、不支持。
- **`rate-limits.js`** — 模型限流（429）台账：扫 `~/.workbuddy/logs` 与 `~/.codebuddy/logs` 最近 2 天日志，从「超出频率限制」行提取官方恢复时刻（`将在 … UTC+8 重置`），按 sessionId→`resolved model` 归因模型、uid 行/sessions 表归因账号。模块内 60s 缓存，不发网络请求。
- **`server.js`** — 薄 HTTP 服务。`POST /api/sync[/credits|/tokens]` 用 `execFile` 子进程跑 `token-usage-report.js --emit-js`（保证与手动跑行为一致，超时 5 分钟）；`/api/checkin`、`/api/travel` 在进程内直接调 `wbApi`；`/api/checkin-status`（只读）返回签到+旅行状态供看板渲染，顺带把查到的日期并入 `checkin-history.json`；`/api/limits` 返回 429 台账；`POST /api/switch` 切换桌面端账号（互斥锁，与同步同款 409 拒并发）；`/api/status` 报告同步状态、扫描目录与 switchable 账号。同一时间只允许一次同步。CORS 全放行（看板从 `file://` 发跨域请求，Origin 为 null）。
- **`workbuddy-token.html`** — 单文件看板，约 18 万字符，双击即用。所有 UI/逻辑/样式内联，支持本地快照（IndexedDB）、Excel 手工导入、Markdown/CSV 导出。账号卡片渲染状态 chips（签到/旅行/429/建议优先）、登录徽标、余额更新时间与「设为当前」切换按钮；30s 重渲染倒计时、60s 轮询数据。

## token-usage-data.js 字段速查

生成器与看板之间的数据契约（改任一侧都要保持兼容）：

- `t` — 回合表，键为 `conversationRequestId` **小写归一**。值含 `n/in/out/cr/cc/tot/t0/t1/m/s/src/p/lat/latn`；非 `--light` 时另有 `d` = 每步明细 `[[时间ms, 工具, 输入, 输出, 缓存读, 模型耗时ms], …]`，第 6 位是后加的，旧数据只有 5 位，读取方需按「undefined 即无数据」兼容。
- `ti` — 会话标题映射（会话ID → `ai-title` 记录），会话级而非回合级。
- `bill` — 官方账单紧凑行 `[requestId, credit, model, client, 时间ms, 账号下标]`，下标指向 `uids`。
- `uids` — 账号下标表（行里存下标，避免每行重复写 uid）。
- `acct` — 各账号余额快照（当前值，非累加量）；每行可带 `login`（本机登录态：`app` 为最近登录来源、`apps` 为各 app 的凭证到期时间，仅 app 名与时间戳、不含 token），看板据此在账号卡片右上角渲染登录徽标。
- `su` — 会话ID → 账号 uid 映射，来自 `~/.workbuddy/workbuddy.db` 的 `sessions.user_id`（经 `node:sqlite` 只读，Node 22.5+ 可用，低版本静默返回空）。CLI 会话不在库里，靠账单 requestId 反向标注补。
- `hist` — 余额历史 `{uid: [[ts, remaining], …]}`（同账号同天只留最后一条），趋势图用。

## 必须遵守的约束

- **看板固定用 `file://` 打开**，不要用 `http://127.0.0.1:8099` 托管页面——浏览器存储按地址隔离，混用会把「本地快照」分裂成两份。服务只当后台 API。
- **Token 口径两条铁律**：`total_tokens = input_tokens + output_tokens` 恒成立；`cache_read_input_tokens` 是 `input_tokens` 的子集（不是增量，不可相加）。缓存命中率 = `cache_read_input_tokens / input_tokens`。
- **回合对齐**：账单 `RequestID` 对应会话记录的 `providerData.conversationRequestId`（回合级，一次提问 = 一个回合 ≈ 7+ 次 API 请求），**不是** `messageId`。按 `messageId` 匹配对不上。
- **官方账单接口的服务端行为**：查询窗口 >31 天返回空（脚本按 30 天切分）；单页最多 3000 条且从窗口起点取（脚本按「本页最新时间」推进分页）。改动拉取逻辑时必须保留这两个防御。
- **隐私白名单**：账单接口响应带 `input`（提问正文），只允许提取 `requestId / credit / model / client / requestTime` 五个字段，正文解析时即丢弃。凭证 accessToken/refreshToken 只在内存使用。
- **数据文件不入库**（`.gitignore` 已排除）：`token-usage-data.js`、CSV、`checkin-history.json` 等含真实会话 UUID、账号 uid/昵称，属个人隐私。
- **增量合并是默认行为**：`token-usage-data.js` 的本地 Token 部分与官方账单部分都是增量追加、只增不减（本地记录被清理后历史不丢、账单窗口外历史保留）。改生成逻辑时不得破坏这一点；`uids` 下标表重排时历史行的账号归属必须保持正确。
- 响应耗时是推算的（记录无现成耗时字段）：`function_call` 时间戳 − 上一次 `function_call_result`/用户消息时间戳 = 纯模型耗时。窗口外（<0.5s / >1h）记 0 表示无效。

## 平台注意

面向 Windows（bat 脚本、`%LOCALAPPDATA%` 路径），路径拼接统一用 `path.join`/`os.homedir()`。所有注释与 UI 文案为简体中文。
