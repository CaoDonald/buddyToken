# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## 项目概述

buddyToken：把 AI 编码助手（WorkBuddy 桌面端 / CodeBuddy CLI）的积分账单与本机会话记录的 Token 消耗按回合对齐的本地看板。纯本地运行，**零 npm 依赖**——Node 脚本只用标准库，看板的 `xlsx` / `chart.js` 走 CDN。无构建、无测试、无 lint 步骤。

## 常用命令

```bash
node token-usage-report.js --emit-js              # 全量：扫本地会话 + 同步官方账单，生成看板数据（默认 7 天）
node token-usage-report.js --emit-js --light      # 省略每步明细，产物约小一半
node token-usage-report.js --emit-js --no-merge   # 关闭增量合并，纯全量覆盖
node token-usage-report.js --emit-js --only=credits  # 刷官方账单/余额 + 顺带重扫本地会话
node token-usage-report.js --emit-js --only=credits --uid <uid>  # 只刷某一个账号的积分（看板卡片上的「🔄 刷新」走这条），同样带重扫
node token-usage-report.js --emit-js --only=tokens   # 只扫本地会话
node token-usage-report.js --emit-js --no-official    # 完全跳过官方同步（纯离线）
node token-usage-report.js --reset                    # 清空所有数据文件（回到未同步过的状态）
node token-usage-report.js --emit-js --official-days 30  # 官方拉取窗口（默认跟随 --days，兜底 7 天；账单还是空的时自动改拉全部历史约 1 年）
node token-usage-report.js --days 7 | --since 2026-09-01 | -o D:\out

node server.js          # 本地服务（127.0.0.1:8099，端口被占用自动 +1），提供 /api/sync 等
node server.js --no-open  # 启动但不自动打开看板

node cloud-sync.js             # 手动跑一轮云同步（多端汇总，读 sync-config.json）
node cloud-sync.js --dry-run   # 只统计将要推/拉的行数，不联网写、不落盘
node cloud-sync.js --push      # 只推不拉（--pull 反之）
```

Windows 下 `同步Token.bat`（一键全量同步+打开看板，不必先起服务）、`打开看板.bat`（起服务+打开看板）分别是两条主要入口。要求 Node 18+（用到 `util.parseArgs`）。

## 架构

六个模块：五个在主干上单向流动——**本地 jsonl + 官方接口 → token-usage-report.js → token-usage-data.js → 看板 HTML**；第六个 `cloud-sync.js` 是旁挂的一层，只在这条链的末端读写同一个数据文件，不改变链路本身。

- **`token-usage-report.js`** — CLI 主脚本。扫描 `~/.workbuddy/projects/**` 与 `~/.codebuddy/projects/**` 下的 `.jsonl` 会话记录（一条带 `message.usage` 的记录 = 一次 API 请求），产出 `token-usage-data.js`（`window.__TOKEN_DATA__ = {...}` 形式的 JS 文件，而非 JSON——因为 `file://` 下 fetch 不可用，看板靠动态注入 `<script>` 加载）、CSV 明细和 Markdown 汇总。`workbuddy-api.js` 加载失败时静默降级为纯本地扫描。
- **`workbuddy-api.js`** — 官方接口封装：从 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info` 发现账号凭证，拉积分账单、余额、套餐，及签到/猫猫旅行。**两个域不能混用**：账单在 `workbuddy.cn`，签到/活动在 `codebuddy.cn`。凭证只在内存使用，绝不写盘。另有账号库与切换：auth 目录的历史快照按 (uid, app) 分组即「可切换账号」——`workbuddy-desktop*.info` 属 WorkBuddy 桌面端、`Tencent-Cloud.coding-copilot*.info` 属 CodeBuddy CLI（归属已用 CLI 日志鉴权 uid 实证），切换 = 把目标快照整份写回该 app 的当前登录文件（原子写 + 备份到项目 `switch-backups/`，含 token 已 gitignore）；桌面端切换需要重启 WorkBuddy 才重读登录态（exe 路径：进程路径→注册表→常见候选）；`codebuddy-cli` 侧每次请求都重读登录态，写完即生效、无需重启。IDE 登录态不在此目录、不支持。
- **`rate-limits.js`** — 模型限流（429）台账：扫 `~/.workbuddy/logs` 与 `~/.codebuddy/logs` 最近 2 天日志，从「超出频率限制」行提取官方恢复时刻（`将在 … UTC+8 重置`），按 sessionId→`resolved model` 归因模型、uid 行/sessions 表归因账号。模块内 60s 缓存，不发网络请求。
- **`server.js`** — 薄 HTTP 服务。`POST /api/sync[/credits|/tokens]` 用 `execFile` 子进程跑 `token-usage-report.js --emit-js`（保证与手动跑行为一致，超时 5 分钟）；`/credits` 可带 body `{uid}` 只刷该账号（uid 经正则校验后透传成 `--uid=`，execFile 不走 shell）；`/api/checkin`、`/api/travel` 在进程内直接调 `wbApi`；`/api/checkin-status`（只读）返回签到+旅行状态供看板渲染，顺带把查到的日期并入 `checkin-history.json`；`/api/limits` 返回 429 台账；`POST /api/switch` 切换账号（`workbuddy-desktop` 或 `codebuddy-cli`，互斥锁，与同步同款 409 拒并发）；`POST /api/reset` 清空数据文件（与同步共用同一把锁）；`/api/status` 报告同步状态、扫描目录与 switchable 账号。同一时间只允许一次同步。CORS 全放行（看板从 `file://` 发跨域请求，Origin 为 null）。
- **`cloud-sync.js`** — 多端云同步（Supabase）。每台机器把自己的数据推到云端一个「传阅箱」，再把别人推的拉回来合进本地数据文件，看板于是看到多端汇总、并可**按机器筛选**。**看板不直连云端**：`file://` 页面里放 anonKey 等于公开，所以 key 只留在本机 `sync-config.json`（已 gitignore）。零依赖，直接走 Supabase 自带的 PostgREST（Node 原生 `fetch`），不引 `@supabase/supabase-js`。由 `server.js` 一个独立定时器驱动，周期与凭证都在 `sync-config.json`，**不进 `auto-config.json`**——后者是白名单式重建，凭证类字段会被当未知字段丢掉。合并逻辑全是不碰网络与文件的纯函数（`planTurnMerge` / `planBillMerge` / `planHistMerge` / `planAcctMerge` / `planTitleMerge`），可单独断言「只增不减」。建表 SQL 见 `supabase-cloud-sync.sql`。
- **`workbuddy-token.html`** — 单文件看板（约 4.4 千行），双击即用。所有 UI/逻辑/样式内联，支持本地快照（IndexedDB）、Excel 手工导入、Markdown/CSV 导出。账号卡片渲染状态 chips（签到/旅行/429/建议优先）、登录徽标、余额更新时间、今日/昨日消耗（账单按自然日聚合）与「🔄 刷新」按钮（刷该账号积分并重扫本地 Token）；切换账号只由卡片右上角的三个应用图标承担；30s 重渲染倒计时、60s 轮询数据。「⋯ 更多」菜单末尾是「🗑 一键清空数据」：清项目数据文件（走 `/api/reset`）+ 浏览器快照（`Persist.clear()` + `LocalScan.clear()`），清完 `location.reload()` 回到初始界面，两道确认且不可撤销。

## token-usage-data.js 字段速查

生成器与看板之间的数据契约（改任一侧都要保持兼容）：

- `t` — 回合表，键为 `conversationRequestId` **小写归一**。值含 `n/in/out/cr/cc/tot/t0/t1/m/s/src/p/lat/latn`；云同步启用时另有 `mch` = 机器标识（未启用则整个字段缺席，不给每个回合白挂一份 UUID）；非 `--light` 时另有 `d` = 每步明细 `[[时间ms, 工具, 输入, 输出, 缓存读, 模型耗时ms], …]`，第 6 位是后加的，旧数据只有 5 位，读取方需按「undefined 即无数据」兼容。
- `machines` — 机器名册 `{machineId: 显示名}`。本机那条由 `token-usage-report.js` 写入，其它机器由 `cloud-sync.js` 从云端拉回；未启用云同步时是空对象。
- `ti` — 会话标题映射（会话ID → `ai-title` 记录），会话级而非回合级。
- `bill` — 官方账单紧凑行 `[requestId, credit, model, client, 时间ms, 账号下标]`，下标指向 `uids`；云同步启用时另有第 7 位 = 机器标识（账单本身是账号维度、没有机器，靠 `request_id` 与回合同源反查得到；反查不到的为空，看板归入「未标注」）。旧数据没有第 7 位，读取方需按 `undefined` 兼容。
- `uids` — 账号下标表（行里存下标，避免每行重复写 uid）。
- `acct` — 各账号余额快照（当前值，非累加量）；每行可带 `login`（本机登录态：`app` 为最近登录来源、`apps` 为各 app 的凭证到期时间，仅 app 名与时间戳、不含 token），看板据此在账号卡片右上角渲染登录徽标。
- `su` — 会话ID → 账号 uid 映射，来自 `~/.workbuddy/workbuddy.db` 的 `sessions.user_id`（经 `node:sqlite` 只读，Node 22.5+ 可用，低版本静默返回空）。CLI 会话不在库里，靠账单 requestId 反向标注补。
- `hist` — 余额历史 `{uid: [[ts, remaining], …]}`（同账号同天只留最后一条），趋势图用。

## 必须遵守的约束

- **看板固定用 `file://` 打开**，不要用 `http://127.0.0.1:8099` 托管页面——浏览器存储按地址隔离，混用会把「本地快照」分裂成两份。服务只当后台 API。
- **Token 口径两条铁律**：`total_tokens = input_tokens + output_tokens` 恒成立；`cache_read_input_tokens` 是 `input_tokens` 的子集（不是增量，不可相加）。缓存命中率 = `cache_read_input_tokens / input_tokens`。
- **回合对齐**：账单 `RequestID` 对应会话记录的 `providerData.conversationRequestId`（回合级，一次提问 = 一个回合 ≈ 7+ 次 API 请求），**不是** `messageId`。按 `messageId` 匹配对不上。
- **官方账单接口的服务端行为**：查询窗口 >31 天返回空（脚本按 30 天切分）；单页最多 3000 条且从窗口起点取（脚本按「本页最新时间」推进分页）。改动拉取逻辑时必须保留这两个防御。窗口之间按 `BILLING_CONCURRENCY`（4）路并发拉取——账号内并发、账号间串行，结果按下标回填以保持顺序；配套的同账号刷新去重 `refreshAccountOnce` 不能去掉，否则并发撞 401 时重复刷新会让先刷出来的 refresh token 作废。
- **隐私白名单**：账单接口响应带 `input`（提问正文），只允许提取 `requestId / credit / model / client / requestTime` 五个字段，正文解析时即丢弃。凭证 accessToken/refreshToken 只在内存使用。
- **数据文件不入库**（`.gitignore` 已排除）：`token-usage-data.js`、CSV、`checkin-history.json` 等含真实会话 UUID、账号 uid/昵称，属个人隐私。
- **增量合并是默认行为**：`token-usage-data.js` 的本地 Token 部分与官方账单部分都是增量追加、只增不减（本地记录被清理后历史不丢、账单窗口外历史保留）。改生成逻辑时不得破坏这一点；`uids` 下标表重排时历史行的账号归属必须保持正确。
- **云同步的合并同样只增不减**：`cloud-sync.js` 的 `plan*` 系列全是「缺失才加 / 更优才覆盖」，没有任何删除路径。三个容易踩的坑：① 远端账单行的 uid 是**文本**，合并回本地时必须翻译成本机 `uids` 下标（本机没有该 uid 就追加到末尾），沿用远端下标会让历史账单归属整体错位；② 余额历史合并后要**回写 `credit-history.json`**，否则下一轮刷积分（`data.hist = h.byUid` 是整体替换）会把刚拉回来的远端历史抹掉；③ `mergeOfficialData` 重建历史行时要带上第 7 位机器标识，漏掉则每同步一次就丢一层机器标注。
- **云同步的凭证不入库、不出本机**：`sync-config.json`（Supabase anonKey）与 `sync-state.json`（machineId 与同步游标）都在 `.gitignore` 里；`--reset` 的删除白名单**不含**这两个文件——它们是配置不是数据产物。云端表名统一 `bt_` 前缀以免与同项目其他业务撞名，RLS 全开并放行 anon 是单人自用场景的取舍，key 泄露须去 Supabase 轮换。
- **云同步失败不得影响本地**：网络不通只打警告并记 `lastResult`，本地数据产出与看板照常。云同步与同步子进程共用一把 `syncing` 锁（两者都写 `token-usage-data.js`，必须串行），失败后等一个完整周期再重试而不是每 30 秒重试一次。另外它**不能挂进 `runAutoTaskBody`**——那里第 718 行有 `if (!wbApi) throw`，而云同步不依赖 `wbApi`。
- **云同步的代理只能在子进程启动时给**：`*.supabase.co` 走 Cloudflare，国内直连会被 TLS 阶段重置（`ECONNRESET`），而系统代理只有浏览器会走。Node 的 fetch（undici）**只在模块初始化时**读 `NODE_USE_ENV_PROXY`，运行时改 `process.env` 无效（实测：同进程内先设再 fetch 仍失败）。因此：CLI 由 `cloud-sync.js` 的 `reexecWithProxyIfNeeded()` 带环境变量重跑自己，服务端由 `server.js` 的 `runCloudSyncProcess()` 用 `execFile` 起子进程并传 `proxyEnv(cfg)`。**不要把这条路径改成进程内函数调用**，否则代理配置形同虚设。另外 `bt_machines` 没有 `updated_at` 列，不能进建表 SQL 里的触发器数组（否则写入时直接报 `record "new" has no field "updated_at"`）。
- **`--only=credits` 与 `--only=tokens` 靠数据文件互传字段**：两步是两次独立进程调用，官方字段都从旧文件带回。`--only=credits` 顺带重扫本地（2026-09-22 起，此前只刷官方导致 Token 数字停在旧时点、像丢了数据），但「文件不存在」时的空骨架必须带 `t`/`ti`，`loadExistingTokenData` 也不能拿「有没有 `t`」当有效性判据（需要 `t` 的调用方自行 `|| {}` 判空）——重扫失败时产物可能只有官方字段，若因此被判无效，第二步会把刚拉回来的账单整块丢掉，前端拿不到 `bill` 就构建不出数据集，看板停在上传界面。2026-09-21「一键清空」上线后正是踩了这个坑（清空 → 一键同步 → 账单全丢）。
- 响应耗时是推算的（记录无现成耗时字段）：`function_call` 时间戳 − 上一次 `function_call_result`/用户消息时间戳 = 纯模型耗时。窗口外（<0.5s / >1h）记 0 表示无效。
- **清空是白名单删除，不是通配符清理**：`--reset` 只删固定的 5 个产物（`token-usage-data.js`（含 `--js-out` 指定名）/ `token-usage-detail.csv` / `token-usage-summary.md` / `credit-history.json` / `checkin-history.json`），连目录都不递归；`switch-backups/`、手工导入的 `*.xlsx` 与 `~/.workbuddy`、`~/.codebuddy` 的原始 jsonl 永不删除。看板的「🗑 一键清空数据」= 服务端删文件 + 页面清 IndexedDB/localStorage/目录授权，**两处必须一起清**（只清一边会出现「文件没了页面还显示旧数据」或「页面空了下次同步数据又回来」），清完靠 `location.reload()` 复位而非逐个改内存状态。

## 平台注意

面向 Windows（bat 脚本、`%LOCALAPPDATA%` 路径），路径拼接统一用 `path.join`/`os.homedir()`。所有注释与 UI 文案为简体中文。
