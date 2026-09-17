# buddyToken · 积分消耗看板

把 AI 编码助手的**积分账单**和**本机会话记录里的 Token 消耗**关联起来，看清每一分积分到底换来了多少 Token。

**适用于 WorkBuddy 桌面端与 CodeBuddy CLI**。两者内核相同、会话记录格式一致，只是根目录不同，本项目同时扫描两边。

纯本地运行，零服务端、零依赖安装（脚本只用 Node 标准库，看板的图表库走 CDN）。

---

## 它解决什么问题

AI 助手的积分账单只会告诉你「这一次提问扣了 0.37 积分」，但不会告诉你：

- 这 0.37 积分背后实际消耗了多少 Token？
- 缓存命中了多少？缓存到底有没有帮我省钱？
- 哪个工具（读文件 / 执行命令 / 搜索）最烧 Token？
- 哪个模型更划算？

这些信息在本地会话记录里其实都有，只是和账单是两份互不相干的数据。本项目把它们对上。

---

## 核心设计：积分与 Token 怎么对齐

**关键点：账单里的 `RequestID` 对应会话记录里的 `providerData.conversationRequestId`，不是 `messageId`。**

这是「回合级」ID。一次用户提问 = 一个回合，但 agent 会在其中串行发起多次 API 请求（实测平均 **7.65** 次，最多上百次）。所以：

```
一行积分  ==  一个回合  ==  该回合全部 API 请求的 Token 之和
```

按 `messageId` 去匹配是行不通的——那个粒度细 7 倍多，绝大多数都对不上。

### Token 口径（两条铁律）

```
total_tokens = input_tokens + output_tokens          恒成立
cache_read_input_tokens <= input_tokens              恒成立
```

`cache_read_input_tokens` 是 `input_tokens` 的**子集**（命中缓存的那部分），**不是额外增量，两者不可相加**。正确算法：

- 总输入 = `input_tokens`
- 未命中缓存 = `input_tokens - cache_read_input_tokens`
- 缓存命中率 = `cache_read_input_tokens / input_tokens`

另外，因为每次请求都要重发全量上下文，同一回合内 `input_tokens` 会逐次累加——这是 API 的真实计费方式，不是重复计数。

---

## 快速开始

### 环境要求

- **Node.js 18+**（脚本用到 `util.parseArgs`）
- 看板需要联网加载 CDN 的 `xlsx` 和 `chart.js`

### 1. 生成 Token 数据

```bash
node token-usage-report.js --emit-js
```

Windows 上也可以直接双击 **`同步Token.bat`**：自动探测 Node → 扫描 → 生成 → 打开看板。

### 2. 打开看板

双击 `workbuddy-token.html`，把积分账单 Excel **拖进去**即可。

看板会自动按 `RequestID` 关联本地 Token 数据。之后有新数据时，点顶栏的「🔄 同步 Token」重新加载即可，不必刷新页面。

---

## 看板能看什么

**KPI**

- Token 总量 / 缓存命中率
- **每积分 Token**、每 M Token 积分（把积分和 Token 换算起来）
- **免费模型 Token**（0 积分但确实消耗了 Token 的记录）
- **积分覆盖**（Token 数据覆盖了多少比例的实际花销）

**图表**

- 每日趋势三轴对比（柱=积分，线=Token / 请求数）
- Token 趋势（逐日堆叠：缓存读 + 未命中输入 + 输出，合计=总 Token）
- 模型 × 时段热力图、各模型每日堆叠

**表格**

- Token 消耗 Top 10 回合（按 Token 排序，带步骤数与回合时长）
- 工具 Token 消耗排行
- 模型 / 客户端 / 每日明细，均带 Token 与「Token/积分」列

**报告与导出**

- 自动生成分析报告与优化建议
- 可导出 Markdown / CSV，CSV 带 BOM，Excel 打开不乱码

---

## 积分账单格式

需要这几列（列名支持中英文别名，会自动识别）：

| RequestID | 积分消耗 | 模型 | 客户端 | 时间 |
| --- | ---: | --- | --- | --- |
| `a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6` | 1.25 | `your-model` | CLI | 2026-01-15 14:30:00 |

`RequestID` 是 32 位十六进制串。多条记录按 RequestID 去重合并，所以可以多次导入、逐步累积。

---

## 数据来源

脚本扫描本地会话记录（只读，不会上传任何东西）：

| 客户端 | 目录 |
| --- | --- |
| WorkBuddy 桌面端 | `%USERPROFILE%\.workbuddy\projects\<工作区>\*.jsonl` |
| CodeBuddy CLI | `%USERPROFILE%\.codebuddy\projects\<项目>\*.jsonl` |

每个 `.jsonl` 是一个会话，一条带 `message.usage` 的记录 = 一次 API 请求。

### 常用参数

```bash
node token-usage-report.js --emit-js            # 生成看板数据
node token-usage-report.js --days 7             # 只统计最近 7 天
node token-usage-report.js --since 2026-09-01   # 起始日期
node token-usage-report.js --emit-js --light    # 省略每步明细，文件小一半
node token-usage-report.js --emit-js --no-merge # 关闭增量合并，纯全量覆盖
node token-usage-report.js -o D:\out            # 指定输出目录
```

### 增量合并

看板数据是**增量合并**写入的：生成前会读取已有的 `token-usage-data.js`，把历次同步过、但本次本地已经扫不到的回合原样保留。这样即使本地会话记录被清理，历史 Token 数据也不会凭空消失。

同名回合以本次扫描为准（正在进行的会话会在后续同步里被补齐）。想丢弃历史用 `--no-merge`。

---

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `workbuddy-token.html` | 单文件看板，双击即用 |
| `token-usage-report.js` | 零依赖 Node 脚本，扫描会话记录并生成数据 |
| `同步Token.bat` | Windows 一键脚本：探测 Node → 扫描 → 生成 → 打开看板 |
| `token-usage-data.js` | **脚本产物，不入库**（见下） |
| `token-usage-detail.csv` | 逐条请求明细，**不入库** |
| `token-usage-summary.md` | 汇总报告，**不入库** |

---

## 为什么数据文件不入库

`token-usage-data.js` 里包含**真实的会话 UUID、回合 ID 和完整的本机项目路径**（例如 `C:\Users\<你的用户名>\...`）。这些属于个人使用痕迹，仓库里的 `.gitignore` 已默认排除它们。

所以你 clone 下来后打开看板会看到**空看板**——这是正常的，先跑一次 `同步Token.bat`（或 `node token-usage-report.js --emit-js`）就有数据了。

---

## 实现说明

### 看板怎么加载数据

浏览器在 `file://` 协议下**无法用 `fetch` 读取同目录文件**（会被 CORS 拦），但 `<script>` 标签可以跨同目录加载。所以脚本产出的是 `window.__TOKEN_DATA__ = {...}` 形式的 JS 文件，看板用动态注入 `<script>` 的方式加载，并带时间戳绕开缓存。

这样双击 HTML 就能用，不需要起本地服务器。

### 匹配覆盖率会低于 100%

积分账单是**账号级**计费口径，覆盖所有设备；本地 jsonl 只是**本机**留痕。如果同一账号在多台设备或不同入口使用，账单里会有一部分记录在本机找不到对应会话。

看板对此的处理是：主指标用**积分覆盖率**（Token 数据覆盖了多少比例的实际花销），条数放在副标题，并且**不用警告色**——这是数据可得性的正常现象，不是错误。

---

## License

未指定。如需开源分发请自行补充。
