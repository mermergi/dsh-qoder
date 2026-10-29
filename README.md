# dsh-plugin-qoder

登录 **Qoder** 并把 **Qoder Cloud 模型**作为 LLM Provider 接入 **DeepSeek Harness (dsh)**，
让你可以在 dsh 里选择 Qoder 的模型进行对话与代码开发。

## 工作原理

Qoder 对外只提供了 **Cloud Agents** 这套有状态 API：

```
Agent(模型+系统提示+工具) + Environment(云端沙箱) → Session
  → POST user.message
  → 通过 SSE 读回 session.status_running / span.model_request_* /
     agent.thinking / agent.message / agent.tool_use / agent.tool_result /
     session.usage / session.status_idle
```

而 dsh 的 `llm` provider 扩展点是一个**无状态的流式补全**契约（把完整历史 + dsh
自己的工具 schema 交给适配器，要求返回 `StreamChunk`）。

本插件把两者桥接起来：

- 一个 dsh 会话（`sessionId`）映射为一个**长期存在的 Qoder Session**，历史由
  Qoder 服务端维护，插件每轮只发送最新的 user 消息（两处例外：冷 Session 先补一段
  历史转写，工具续跑时顺带转发中途插入的指令——见下文对应章节）。
- **本地工具桥接（`bridgeLocalTools`，默认开启）**：dsh 自己的工具清单会被重新
  发布成 Qoder 的**客户端自定义工具**（加前缀避免与内置名冲突，如 `Read` →
  `dsh_Read`）。于是模型只做决策，**实际执行发生在你这台机器上**：

  ```
  dsh 交给适配器 tools[] ──注册为 custom tools──▶ Qoder Agent
  Qoder 发出 agent.custom_tool_use，Session 以 stop_reason=requires_action 暂停
    ◀── 插件转成 dsh 的 tool-call，本轮以 { kind: 'tool-calls' } 结束
  dsh 在本地真实执行（读文件/改代码/跑命令），带 result 再次调用适配器
    ── POST user.custom_tool_result ──▶ 同一个 Session 继续跑，给出最终答案
  ```

  桥接时 Qoder 的**内置文件类工具会被显式排除**。这一点很关键：只声明 custom 工具
  并不能关掉内置工具，而 `enabled_tools` 留空等于**全部打开**，模型就会去读它那个
  空的云端沙箱，然后告诉你「你的文件不存在」。
- `bridgeLocalTools: false` 时回到旧行为：Qoder 在云端沙箱运行它自己的工具，只回传
  最终文本，一轮以 `{ kind: 'stop' }` 结束。
- 鉴权使用 **Personal Access Token (PAT)**，通过 dsh 的 `credentials` 服务
  （或启动环境变量）解析，并以 `Authorization: Bearer <PAT>` 发送——与 Qoder API
  要求一致。
- **推理等级**：Qoder 模型目录里的 `efforts`（`none/low/medium/high/xhigh/max` 的子集）
  会发布给 dsh 的模型选择器，于是选择器里像官方模型一样出现推理强度子菜单；选择结果
  作为 Agent 的 `model.effort` 发送。切换模型或推理等级时，插件用
  `POST /sessions/{id}` + `x-qoder-beta: session-agent-patch-2026-07-21` **原地修改
  云端 Session**，不重建会话、不丢云端历史。
- **积分**：目录里的 `price_factor` 会显示成模型列表里的倍率徽标（`0.5×`、`0×` 等）；
  每轮 `span.model_request_end.model_usage.credits` 与会话累计 `session.usage` 汇总成
  积分统计，由会话头部的积分徽标展示（数据经插件自己的 `/qoder/credits` 路由提供，
  见「推理等级、积分倍率与积分统计」）。
- **思考过程**：`agent.thinking` 会渲染成 dsh 的**推理块**。注意 Qoder Cloud Agents
  **不公开推理正文**（官方文档原文：“agent.thinking never exposes reasoning
  content”；实测 buffered 事件与 `event_deltas[]=agent.thinking` 都只有开始/结束标记），
  所以块里展示的是本次思考的**推理强度与实际耗时**；若将来某个模型/区域开始携带正文，
  插件会原样展示。

### 桥接的是哪些工具？

dsh 每次调用适配器时，`options.tools` 给的是**当前 agent 可见的完整工具清单**
（`ToolRuntime` 按 scope 解析：全局注册 + 该 agent 作用域链上的注册，再经
`tools.restrict({ allow, deny })` 过滤）。插件对这份清单**不做来源筛选**，全部发布成
`dsh_*` 自定义工具。所以能用上的不只是宿主自带的 `Read/Write/Edit/Bash/Glob/Grep`：

- **其他插件新增的工具**——任何通过 `ctx.tools.register()` / 沙箱里
  `harness.registerTool()` 注册的工具，都会一起桥接，并在本机由 dsh 执行。
- **MCP 工具**——`dsh-mcp-client` 发现的 `mcp__<server>__<tool>` 同样出现在清单里，
  桥接后名字变成 `dsh_mcp__<server>__<tool>`（Qoder 只保留**以** `mcp__` **开头**的
  名字，加前缀即可避开冲突）。
- 执行侧的策略（`tools.guard()` 拒绝、审批弹窗、工具自己的 `execute`）完全不变——
  Qoder 只负责「决定调哪个」，副作用仍发生在你这台机器上、由 dsh 把关。

几点必须知道的边界：

1. **数量上限 128**：Qoder 限制一个 Agent 的 `tools` 数组最多 128 条，插件留 1 条给
   云端 toolset 声明，因此**单轮最多桥接 127 个**工具。装了很多插件/MCP server 时超出
   的部分会被丢弃，并写一条 warn（`~/.dsh/qoder-plugin-load.log`），此时应在 profile
   里停掉用不到的 server / 插件，或用 `tools.restrict()` 收窄可见性。
2. **名字会被规范化**：非 `[A-Za-z0-9_]` 字符替换为 `_`，并按大小写不敏感去重——两个
   仅差特殊字符的工具名只会保留第一个。
3. **PTC 呈现模式**：若把 tools 的 `mode` 设成 `ptc`，dsh 只向模型呈现 `run_code`，
   桥接也就只剩这一个工具（`both` 时额外多出 `run_code`）。
4. **渐进式披露被摊平**：适配器不声明 `toolUpdate`，dsh 会剥掉 `deferLoading` 把整份
   清单一次性交给 Qoder，所以工具是「一轮全给」而不是按需增量披露。

### 上下文长度是谁定的？

**两边各有一个上下文窗口，它们相互独立**：

| 哪一侧 | 由什么决定 | 管的是什么 |
| --- | --- | --- |
| dsh | 适配器 `resolveModel()` 返回的 `context.contextWindow` | dsh **自己那份 history** 的 token 计量与 compaction 阈值（`thresholdTokens = floor(min(contextWindow × thresholdRatio, 预算))`），以及界面上「~已用 / 总量」的分母 |
| Qoder | Agent 的 `model.context_window` 档位（设置页逐模型选择，或全局 `agentContextWindow`；来自模型目录 `available_context_windows`，不传则用 `default_context_window`，硬上限 `max_input_tokens`） | **云端 Session 自己累积**的全部上下文：系统提示（含桥接指令）+ 工具 schema + 每轮工具结果 + thinking |

插件现在的做法：

1. **上报给 dsh 的数字不再拍脑袋**：改从 `GET /api/v1/cloud/models` 返回的
   `default_context_window` / `max_input_tokens` 取，并按 `max_input_tokens` 封顶；
   `contextWindow` 配置项默认 `0`（自动），只在需要强制时才手写。
2. **真的能拉长云端窗口**：`agentContextWindow` 会作为 `model.context_window` 一并
   发给 Qoder（必须在该模型的 `available_context_windows` 里，否则丢弃并告警）。
   档位越大，每轮消耗积分越多。
3. **选定的模型会真正生效**：`stream()` 现在读 `options.model`（以前固定用
   `defaultModel`，在 dsh 里换模型不会生效）；而 Session 与 Agent 都按「会话 + 模型」
   缓存，中途换模型会开一个新的 Qoder Session。

一个必须知道的不对称：桥接模式下每轮**只发送最新的 user 消息**（冷 Session / 工具续跑
两个例外见下文），历史存在 Qoder 服务端。
所以 dsh 自己的 compaction **无法真正缩短云端 Session**——它只减少 dsh 侧的记账，
而 dsh 也看不到云端那份额外开销。两边都只朝一个方向安全：把 dsh 的 `contextWindow`
报得**小于等于**云端真实窗口。若你看到 dsh 一直不压缩而 Qoder 开始丢早期上下文，
就调低 `agentContextWindow` 或新开一个会话。

#### 换了模型 / 推理等级 / 重启之后，模型为什么「失忆」？（已修）

**换模型或推理等级不再丢历史（2026-10-29 起）**：Session 现在按「会话」缓存，模型与
`effort` 属于运行期配置。切换时插件用 `POST /sessions/{id}`（带 beta 头
`session-agent-patch-2026-07-21`）**原地 patch** 云端 Session 的 `agent.model`，
历史原样保留。只有两种情况仍会新建 Session 并触发下面的历史回放：

1. **宿主重启**（内存里的 Session 映射丢失）；
2. **云端拒绝这次原地切换**（例如该 Session 已不可更新）——插件会告警、中断旧 Session，
   新建一个并立即回放转写。

历史回放（`replayHistory`，默认 `true`）会先从 dsh 自己的历史里拼一段转写
（`user:` / `assistant:` 逐条，保留最近的、总共 ≤ 24k 字符，单条 ≤ 2.5k），
夹在本次 user 消息之前一起发出：

```
[Context replay: transcript of this conversation before the current message, …]
user: ……
assistant: ……
[End of context replay. The current request follows.]
<当前用户输入>
```

只用一次（之后 `fresh` 置为 false，不会重复灌）。工具往返**不进转写**——云端 Session
自己会重放它的工具循环，把旧的工具结果塞回去反而会被当成「再执行一次」。代价是冷启动
那一轮的输入 token 变多；不想要就把 `replayHistory` 设成 `false`。

#### 那云端上下文满了会怎么样？

**Qoder 会在服务端自己压缩（compaction），而不是直接把请求拒掉**：

1. 正常情况下它会发出一个 `agent.thread_context_compacted` 事件，把较早的轮次
    **摘要成一段**后继续跑。Token 数不对外暴露，但摘要本身是一次模型调用，
    可能带 `usage.credits`（已计入 Session 的 `model_credits`，**不要重复累加**）。
    代价是：很久以前的细节从此变成二手信息，“第 3 轮那个变量名”这类提问会开始错。
    插件会把这件事**当一行说明显式告知你**（这个事件以前被静默丢掉了，于是长对话
    “悄悄变差”无人知晓）。
2. 压缩也顶不住时，会话会以 `session.error`（带原因与重试状态）或直接给一个**非
    `end_turn` 的 `stop_reason`** 收尾。两者都会真实反映：
   - `session.error` → 适配器抛 `PROVIDER_ERROR`，你在 dsh 里看到“本轮运行失败：…”；
   - `max_tokens` → 本轮以 `max-tokens` 结束（dsh 会按“被截断”处理）；
   - 其他（如 `retries_exhausted`）→ 回答后面追加一行
     `(Qoder stopped this turn with stop_reason "…".)`，不再把断掉的一轮当成正常答复。
3. **dsh 侧的数字会自动跟上云端事实**：新建 Session 返回的
   `agent.model.effective_context_window`（已含环境级覆盖）会被记住，并在后续
   `resolveModel()` 里**优先于**配置档位与目录默认值上报给 dsh。于是 dsh 的压缩阈值
   贴合真实云端预算，不会等到云端已经开始丢内容了 dsh 还觉得“窗口很宽”。

实用建议：

- 桥接模式下云端上下文长得**格外快**：每次工具结果（整片文件内容、命令输出）都要
  进云端历史，再加系统提示与全套工具 schema。200k 档位很容易几轮就满。
- 一个任务结束后开新会话，比在同一会话里死撑便宜：新 Session 不会背着旧的工具输出计费。
- 确实需要长程记忆时，显式设置 `agentContextWindow` 到该模型的
  `available_context_windows` 高层级（如 400k/1M），并预期每轮积分上升。
- 想看事件级真相（包括被压缩、被截断的每一轮）：用 `QODER_DEBUG=1` 启动 dsh，
  每个 SSE 帧的类型会写到 stderr。

### 关于「设置 → 模型」里的显示与快捷配置

分两层：

1. **卡片出现**：provider 要出现在 **设置 → 模型** 列表里，插件必须导出一个真实的
   Schemastery `Config` 且含至少一个 `volatile` 字段——settings 服务只会为此类插件
   创建 settings namespace，模型页据此渲染卡片。
2. **在页面上直接填写配置**：模型页内置的「编辑」表单只对 `llm-deepseek` /
   `llm-pi-ai` 两个命名空间渲染，第三方 provider 会退化成「其余字段在 cordis.patch.yml
   中」的提示且禁用保存。为此本插件自带一个浏览器包 **`client.js`**，它注册进模型页
   声明的 keyed 子插槽 `settings.models.provider-card`（`key = "llm-qoder"`），于是
   **Qoder 卡片上会直接内嵌一个配置表单**：一个 PAT 输入框（经 `credentials` 域写入
   凭据引用 `QODER_API_KEY`，正是 `resolveToken` 读取的名字）+ 接口地址 + 默认模型 +
   **默认推理强度**，外加**每个模型的云端上下文窗口下拉框**，点「保存」即生效，无需再
   打开任何文件。同一个浏览器包还在**会话头部**挂了一个 **Qoder 积分徽标**（见下一节）。

> `client.js` 通过 package.json 的 `dsh.client`（`platform: web`）+ `exports["./client"]`
> 被宿主 `ClientModuleRegistry` 发现并作为 `/plugins` 资源提供。**新增该声明后需要完全
> 退出并重启 dsh**（注册表对「是否 client 包」的判定按来源缓存到重启为止，热重载不会
> 让新浏览器包进入启动图）。

> 由于 profile 链接的第三方插件无法 `import` 打进 `app.asar` 的 `@deepseek-ai/*` 服务包，
> 本插件把 `@deepseek-ai/schemastery`（及其唯一运行时依赖 `@deepseek-ai/cosmokit`）
> **vendor 到了自身的 `node_modules/`** 下，从而能构建真实 `Config`。宿主侧仍不依赖任何
> `@deepseek-ai` 服务包（通过 `ctx` 服务与鸭子类型的适配器接入）；`client.js` 仅在浏览器
> 侧 `require` 应用已有的 `react/jsx-runtime` / `react-dom` 与
> `@deepseek-ai/dsh-client-ui-primitives`。

### 推理等级、积分倍率与积分统计

**1. 模型列表里的积分倍率**

`GET /api/v1/cloud/models` 给每个模型带一个 `price_factor`（相对基准价的**参考**积分倍率）。
插件把它发布成 dsh 模型选择器里的**徽标**：`0×` / `0.5×` / `0.8×` / `1×` / `1.25×`；
大于 1 的倍率用警告色。同一个值也会写进模型的 `description`，在会显示描述的界面
（如设置页模型列表）可见。

> `0×` 只是目录标称的参考倍率，**不是“这一轮不扣积分”的保证**：Cloud Agents 的计费项
> 除模型调用外还有**云端沙箱运行时间**，而且目录倍率可能滞后于实际计费/只对订阅档生效。
> 实测目录标 `0×` 的 `qfmodel` 一轮仍回传 `model_credits: 0.07`。以 Qoder 回传的
> `session.usage` 为准（见下方积分统计）。

**2. 推理等级（effort）**

每个模型的 `efforts` 数组就是它接受的推理等级（`none` / `low` / `medium` / `high` /
`xhigh` / `max` 的子集），`default_effort` 是缺省值。插件把这份信息按「从低到高」发布给
dsh，模型选择器里就会出现和官方模型一致的**推理强度子菜单**：

- 只列该模型真实支持的等级（例如 `dmodel` 只有 high/max），并按
  `EFFORT_ORDER` 排序——Qoder 目录里的顺序是乱的；
- `support_disable_reasoning: true` 的模型（如 `dfmodel`）额外提供 `None`（关闭思考）；
- 选择结果随请求下发为 Agent 的 `model.effort`；未选择时用目录的 `default_effort`
  （可用 `defaultReasoningEffort` 覆盖）；
- **切换模型或等级不会丢云端历史**：插件 patch 现有 Session 的 `agent.model`
  （beta 头 `session-agent-patch-2026-07-21`），这是 Qoder 文档里的「动态更新运行时配置」。
  只有 patch 被拒（极端情况）才退回「新建 Session + 历史回放」。

**3. 每个模型的云端上下文窗口（设置页）**

**设置 → 模型 → Qoder 卡片**新增「云端上下文窗口」区：每个模型一行下拉框，选项来自该
模型目录的 `available_context_windows`（例如 `200k` / `400k` / `1M`），默认项是
「模型默认（当前值）」。选择会暂存到表单，点「保存」后写入 `modelContextWindows`
（紧凑格式 `"dmodel=400000,qfmodel=1000000"`）；清空/「恢复默认」则回落到全局
`agentContextWindow`（YAML 配置）或模型自身默认。

- 更大的窗口每轮积分更高；模型的 `max_input_tokens` 仍是硬上限，上报给 dsh 的窗口会被它封顶。
- 保存后从**下一轮**生效：插件把档位作为 `model.context_window` **原地 patch** 当前云端
  Session（历史保留）；未被使用过的模型则从下一个新建 Session 开始生效。
- 该区通过插件自己的 `GET /qoder/models` 路由读取目录，PAT 不出宿主；路由不可用（如
  Electron 外壳）或读取失败时，卡片会显示原因，仍可在 `cordis.patch.yml` 手写该字段。

**4. 积分消耗统计（会话头部徽标）**

Qoder 在两处给出积分：单次模型调用 `span.model_request_end.model_usage.credits`，以及
每个 idle 前的会话累计 `session.usage`（`model_credits` / `sandbox_runtime_credits` /
`total_credits`）。插件把两者汇总后，由 `client.js` 在**会话头部右侧**显示一个积分徽标
（如 `0.56`），点开面板可见：

| 行 | 含义 |
| --- | --- |
| 本轮 | 当前 dsh 轮次内所有模型调用（含工具往返后的续跑）的 span 积分之和 + 请求次数 |
| 本会话累计 | Qoder `session.usage` 的权威累计值；展开可见「模型调用 / 云端沙箱」明细 |
| 本次运行累计 | 本次 dsh 进程启动以来的全部会话积分之和 |
| 模型 / 推理强度 / 推理倍率 | 当前会话最近一轮实际使用的路由信息，倍率为目录 `price_factor` |

实现要点：

- 数据通道是插件自己注册的 Host 路由 `GET /qoder/credits?sessionId=<dsh session id>`，
  JSON 结构见 `test/host-integration.mjs`。浏览器端每 2.5 秒轮询一次（仅页面可见时），
  取不到路由（例如 Electron 外壳没有 `webServer`）就整块不渲染。
- `session.usage` 是**快照，不是增量**：插件整体替换，绝不重复累加（重复累加会把长期
  会话的积分算成几倍）。沙箱费用可能在 idle 之后才结算，下一轮 idle 前才进快照，所以
  显示的数字可能略滞后于控制台。
- 若会话因 patch 被拒而换了新的云端 Session，旧 Session 的累计值会被**结转**到
  「本会话累计」上，同一次运行内数字不会倒退（宿主重启后统计从零开始，见下条）。
- **头部徽标显示的是积分（Credits），不是时间。** 数字取自 `session.usage.total_credits`
  （最多两位小数）；「本轮 / 本会话累计 / 本次运行累计」都是积分。唯一显示时间的地方是
  思考过程块里的 `4.2s`（那是思考耗时）。
- **为什么 `0×` 模型也会扣积分**：Qoder Cloud Agents 的计费由两部分组成——
  **模型调用**（按 token 折算，受 `price_factor` 影响）+ **云沙箱运行时间**
  （仅 Session `running` 时按秒计费，暂停/空闲不计费，按小时结算）。桥接模式每一轮都要
  拉起云端沙箱，所以模型费即使是 0，沙箱时间也可能入账；面板的「本会话累计」下面拆出了
  「模型 X · 沙箱 Y」，可以直接看是哪一项。另外沙箱费用结算有延迟：`session.usage`
  快照可能先显示 0，下一轮或稍后才补上。
- 积分是 Qoder 侧计费事实，dsh 自己的 token 计量（消息下方的「本轮用量」）与此独立：
  Qoder Cloud Agents 不返回 token 数，只返回积分。
- 统计只保存在插件进程内存里；重启 dsh 后从下一轮开始重新累计（云端 Session 本身也
  因重启而重建）。历史会话不会回填旧数字。

**5. 思考过程**

`agent.thinking` 被转成 dsh 的 `reasoning` 块，因此对话里会出现「思考过程」折叠行。
Qoder Cloud Agents **不公开推理正文**（官方文档明写 `agent.thinking never exposes
reasoning content`；实测 buffered 事件和 `event_deltas[]=agent.thinking` 都只有阶段
标记），所以块里写的是**推理强度 + 实际思考耗时**，并注明正文未公开。若未来某模型/区域
开始返回正文（`content` / `thinking` / `reasoning` / `text` 任一字段），插件会原样展示，
不需要再改代码。

## 前置条件：拿到 Qoder PAT

1. 登录 **Qoder 控制台**（网页控制台 <https://qoder.com>，或已登录的 Qoder 客户端）。
2. 打开 **Settings → Personal Access Tokens**。
3. 点 **Create token**，填写名称、有效期（expiration）与权限（scope）；调用 Cloud Agents
   （`/api/v1/cloud/*`）至少需要包含 `qca.access`。
4. 复制令牌——**PAT 以 `pt-` 开头**，且完整值**只在创建时显示一次**，请立即保存。

创建后可用下面的命令验证令牌有效（成功会返回一个空的 `data` 列表）：

```powershell
$env:QODER_ACCESS_TOKEN = "pt-你的令牌"
curl.exe -s https://api.qoder.com/api/v1/cloud/agents -H "Authorization: Bearer $env:QODER_ACCESS_TOKEN"
```

> 个人开发用 PAT 即可；团队/服务端自动化可改用 Service Account（SA Key 换短时 SAT），
> 参见 Qoder 文档 *Cloud Agents → Authentication*。

## 安装插件

本仓库的根目录**就是**插件包（`index.js` / `client.js` / `package.json` /
`cordis.patch.yml` 都在根上），clone 下来即可直接安装：

```powershell
git clone https://github.com/mermergi/dsh-qoder.git
cd dsh-qoder
powershell -ExecutionPolicy Bypass -File .\install-plugin.ps1
```

dsh 的插件是安装到某个 **profile** 下的（本机为 `~/.dsh/profiles/desktop`），做法
与官方本地插件 `@local/dsh-plugin-prompt-editor` 完全一致：在 profile 的
`package.json` 里以 `link:` 依赖引入，并加入 `dsh.profile.bundles`。安装脚本会
自动备份原 `package.json`，再执行 `pnpm install`；dsh 的安装目录从 Windows 卸载
注册表自动识别，识别不到时用 `-DshHome` 指定：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-plugin.ps1 -DshHome 'D:\dsh' -ProfileName desktop
```

安装完成后**完全退出并重启 dsh**（不是刷新窗口），Qoder provider 即会出现在模型列表里。

## 配置 Token（二选一）

**A. 环境变量（最简单）** —— 在启动 dsh 的环境中导出：

```powershell
$env:QODER_API_KEY = "pt-你的令牌"
```

**B. dsh 凭据服务（推荐，GUI 持久化）** —— 在 dsh Web UI 的 **设置 → 模型** 页面找到
Qoder provider，点击「编辑」填入 PAT 即可（界面会把密钥存到派生引用
`QODER_API_KEY`）；或在 `~/.dsh/.credentials.yaml` 的 `refs` 下新增：

```yaml
refs:
  QODER_API_KEY: <令牌>
```

> 插件解析令牌时会依次尝试 `QODER_API_KEY`、`QODER_PAT` 两个引用名（含同名环境变量），
> 所以旧的 `QODER_PAT` 依然可用。

## 可选配置

`cordis.patch.yml` 里的 `config` 可覆盖（也可在 Web UI Settings 面板改）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `QODER_API_KEY` | PAT 的凭据引用名（`QODER_PAT` 亦可） |
| `baseURL` | `https://api.qoder.com` | Qoder Cloud API 根地址；**必须与账号区域一致**（全球 `api.qoder.com`，中国 `api.qoder.com.cn`） |
| `defaultModel` | `ultimate` | 新建 Agent 使用的模型 id；以该区域 `GET /api/v1/cloud/models` 为准（中国区无 `ultimate`，如 `dmodel`/`qmodel_38max`/`auto`） |
| `contextWindow` | `0` | 上报给 dsh 的上下文窗口；`0` = 按 Qoder 模型目录的真实窗口（受 `max_input_tokens` 封顶） |
| `agentContextWindow` | `0` | 发给 Qoder 的 `model.context_window` 全局兜底档位（必须 ∈ 该模型的 `available_context_windows`）；`0` = 用模型默认。**单个模型的 `modelContextWindows` 优先**；档位越大每轮积分越多 |
| `defaultReasoningEffort` | 空 | 会话未显式选择推理等级时使用的默认等级；留空 = 用模型目录的 `default_effort`。必须是该模型 `efforts` 里的值（`none` 仅在支持关闭思考的模型上提供）。也可以在模型选择器里逐会话改 |
| `modelContextWindows` | 空 | **每个模型**的云端上下文窗口档位，格式 `"模型id=tokens,模型id=tokens"`（如 `"dmodel=400000,qfmodel=1000000"`）。值必须 ∈ 该模型 `available_context_windows`；留空/清空则回落到 `agentContextWindow`。设置页 Qoder 卡片提供了逐模型下拉框，一般不用手写 |
| `maxTokens` | `8192` | 上报给 dsh 的默认 max tokens |
| `tlsMaxVersion` | `TLSv1.2` | 允许协商的最大 TLS 版本；部分网络会重置 TLS1.3 握手导致 `transport failed`，保持 1.2 即可 |
| `systemPrompt` | 空 | Qoder Agent 的系统提示 |
| `environmentId` | 空 | 指定已有环境；留空则自动选取/创建 |
| `autoCreateEnvironment` | `true` | 无环境时是否自动创建 `default` |
| `agentTools` | `Bash,Read,Write,...` | **仅在关闭桥接时**生效：Qoder Agent 在云端启用的工具集 |
| `bridgeLocalTools` | `true` | 把 dsh 的本地工具发布为 Qoder 自定义工具，由 dsh 在**本机**执行 |
| `cloudTools` | `DeliverArtifacts` | 桥接时仍保留的 Qoder 内置工具。**不要**加入 `Read/Write/Edit/Bash/Glob/Grep`，否则模型会读云端沙箱而不是你的磁盘；留空则退化为仅 `DeliverArtifacts` |
| `localToolPrefix` | `dsh_` | 桥接工具名前缀（Qoder 禁止 custom 工具与内置重名），回传 dsh 时会自动去掉 |
| `replayHistory` | `true` | 冷 Session（宿主重启 / 原地切换被拒后）先把 dsh 侧历史转写灌进去，避免模型「失忆」。冷启动那轮输入 token 会变多。换模型/等级本身已改为原地 patch，不再需要回放 |

## 已知限制（重要）

1. 桥接模式下工具确实在**本机**执行，但每一轮都要**多一次网络往返**（暂停→本地执行
   →回传→续跑），所以比纯聊天慢，且每轮都消耗 Qoder 积分。思考过程只保留在**当前
   会话**的对话记录里；插件**不会**把积分/思考元数据回放给云端，历史回放只含正文。
2. 每轮**只转发最新的 user 消息**（冷 Session 与工具续跑例外，见上文），多轮上下文
   依赖 Qoder Session 服务端记忆。若
   dsh 会话没有稳定 `sessionId`，则每次调用会新建一个 Session（无法跨轮记忆）。副作用：
   dsh 侧的 compaction 只能缩小 dsh 自己的记账，**不会缩短云端 Session**（详见
   「上下文长度是谁定的？」）。
3. Qoder 返回的是**整段** `agent.message`（非逐 token 增量），插件将其作为单个
   文本块输出。
4. `agent.thinking` 会上屏为**推理块**，但 Qoder 只给阶段标记、不给推理正文，所以块里
   是「推理强度 + 耗时 + 正文未公开」的说明（见上文第 4 点）。`agent.tool_result`（云端
   工具输出）不上屏；`agent.tool_use`（模型擅自调用云端内置工具）会以一行说明文字呈现，
   避免整轮静默空白；`agent.thread_context_compacted`（云端自己压缩了历史）同样会明说。
5. 端点必须与**账号区域**一致：全球区用 `https://api.qoder.com`，中国区用
   `https://api.qoder.com.cn`。用错区域会返回 `401 TOKEN_INVALID`
   （`invalid pt-token`），即使令牌本身有效；各区域可用模型 id 也不同（中国区没有
   `ultimate`），以 `GET /api/v1/cloud/models` 的返回为准。

## 故障排查：模型说「读不到你的文件」

这是桥接模式最典型的问题，按顺序排查：

1. **确认改动已生效**：修改插件源码后必须**完全退出并重启 dsh**（热重载不会让新的
   适配器代码进入运行中的宿主）。
2. **确认没有云端文件工具**：`cloudTools` 里不能含 `Read/Write/Edit/Glob/Grep/Bash`。
   若它们可见，模型很可能直接读那个空沙箱。
3. **看原始事件流**：用 `QODER_DEBUG=1` 启动会在 stderr 打印每帧事件类型。出现
   `agent.custom_tool_use` 说明走了本地桥接；只出现 `agent.tool_use` 说明模型还在用
   云端工具。
4. **换个更具体的问法**：点名一个绝对路径（如「读 `d:/dsh/version` 并说出内容」）比
   「看看我的项目」更容易触发工具调用。

## 故障排查：`qoder: transport failed`

若报 `transport failed (ECONNRESET / Connect Timeout)`，并且「模型列表只有 ultimate」，
通常是链路在 **TLS 1.3 握手**阶段被重置：`curl`（默认协商 1.2）能通，而 Node/undici
（默认 1.3）被 RST。插件默认已把进程 TLS 上限固定为 `TLSv1.2` 来规避此问题
（可用 `tlsMaxVersion: TLSv1.3` 还原）。

用下面的命令可区分「网络」与「令牌」问题：

```powershell
curl.exe -s "https://api.qoder.com/api/v1/cloud/models" -H "Authorization: Bearer <PAT>"
```

- 返回 `{"data":[...]}`：链路与令牌都正常，模型列表应能完整拉取；
- 返回 `401`（`TOKEN_INVALID`）：先确认区域与 `baseURL` 一致（全球 `api.qoder.com` / 中国 `api.qoder.com.cn`），换对端点即可；一致仍 401 则令牌无效/过期，需重新生成。
- 超时/连接重置：网络问题（代理、防火墙或中间盒），先切换网络再试。

## 故障排查：消息发出去一直转圈，最后超时

按可能性排序，两个原因都实测过（2026-10-26，Android/Termux，dsh 0.2.1-rc.2）：

1. **Qoder 云端排队（免费档最常见）**。用 `GET /api/v1/cloud/sessions/{id}/events?limit=20&order=desc`
   能看到 `session.error`：

   ```json
   {"error":{"message":"model provider queued the request","qoder_error_code":"10605",
             "retry_status":{"type":"retrying"},"type":"model_overloaded_error"}}
   ```

   同时 `session.status_rescheduled`、`stats.active_seconds` 几乎不涨。这是**模型侧过载**，不是插件问题：
   换一个档位（`gfmodel` GLM-5.3-Flash / `mmodel` MiniMax-M3.1-Flash 是 0.1 倍，实测几秒就回），
   或稍后重试；免费档（`dfmodel` / `qfmodel`，`price_factor = 0`）被排队的概率最高。

2. **已修复的死锁（2026-10-26）**：旧代码先 `GET .../events/stream` 开流、再 `POST .../events` 发消息。
   而 Node 的 `fetch`（undici）在**同源已有响应正在流式传输时，不会返回另一个请求的响应**，于是 POST
   永远等不到响应——云端其实已经收下消息并跑完了本轮，客户端却一直空转（`curl` 无此限制，170ms 返回）。
   现在改成**先 POST 再开流**，并把 POST 返回的事件 id 作为 `Last-Event-ID` 交给流，由服务端从该 id
   之后重放，所以不会漏事件。

## 故障排查：`session is busy with a previous turn`（点过「停止」之后发不出去）

**已修复（2026-10-26）。** 症状：在 UI 里点了停止，之后再发消息就报
`qoder: session is busy with a previous turn`；换模型、退出重进都没用，整个会话废掉。

原因：本地取消只是断开了 SSE 连接，**没有告诉 Qoder 停止那一轮**。云端那轮继续跑
（排队场景下还会一直 retry），Session 就一直被占着，后续每次 POST 都收到 409。

修法两层：

1. **取消即通知云端**：本地 abort（用户点停止、或 5 分钟空闲上限触发）时补发一个
   `user.interrupt` 事件，让云端那一轮真正停下。
2. **409 原位恢复**：真遇到 409 时，先 `user.interrupt`，再轮询 `GET /sessions/{id}`
   等它回到 `idle`（最多 20 秒），然后重试本次 POST 一次——会话不用重开，云端历史也还在。

顺带一提：卡住的会话会**持续计费**（实测一个卡了 24 分钟的会话累计 `total_credits`
5.56，其中 `sandbox_runtime_credits` 4.66）。桥接模式每轮都会拉起云端沙箱，所以
「0× 模型」也不等于零成本——模型费可能是 0（甚至目录倍率与实扣不一致），沙箱运行
时间照扣，以 `session.usage` 为准。

## 故障排查：`resuming a paused turn but no matching tool results were supplied`

**已修复（2026-10-26）。** 上一个问题的变种：停止发生时，Session 正**暂停在本地工具调用**上
（等 dsh 把工具结果回传）。下一条消息到来时，插件发现「该续跑但拿不到工具结果」，就直接报错，
从此这个会话每次都是同一句错。

现在会识别这种情形：把这条永远等不到的暂停标记为放弃、在云端 `user.interrupt` 掉、等它回到
`idle`，再把新消息当作**全新一轮**发出去。同时本地 abort（点停止 / 5 分钟空闲上限）也会清掉
记录的待续工具调用，从源头上避免下一次命中。回归测试：`test/test-abandoned-pause.mjs`。

## 执行中途插入的指令（已修，2026-10-26）

**症状**：agent 正在跑工具循环时，你打一行字插进去，模型完全不理，好像没收到。

**原因**：dsh 会把中途输入 splice 到**下一步**的历史里，而对桥接模式来说下一步就是「把工具
结果回传、续跑云端那一轮」的那次调用。旧实现只发 `user.custom_tool_result`，**从没把这条
新消息发出去**——它既不在云端历史里，也不会被后续任何调用重发，等于静默丢掉。

**修法**：续跑时把「最后一条 assistant 工具调用之后的所有 user 消息」一并带上，作为同一次
POST 里的 `user.message`（排在工具结果之后）。Qoder 接受这种组合（实测：模型会照着这条中途
指令改口），所以既不丢指令，也不用多开一轮。

回归测试：`test/test-steering.mjs`。

## 仓库结构

```
.
├─ index.js                        # 服务端适配器（LLM provider + 本地工具桥接 + 积分统计路由）
├─ client.js                       # 浏览器侧：模型页配置表单 + 会话头部积分徽标
├─ package.json                    # 插件清单（dsh.bundle.patch / dsh.client.inject）
├─ cordis.patch.yml                # 默认配置（baseURL / defaultModel / defaultReasoningEffort 等）
├─ install-plugin.ps1              # 安装到 dsh profile
├─ test/test-smoke.mjs             # 离线：伪造 Qoder HTTP 响应，跑完整一轮
├─ test/test-client.mjs            # 无头：client.js 的 slot 注册与凭据接线
├─ test/test-abandoned-pause.mjs   # 冻结「暂停时被中止」的恢复路径
├─ test/test-steering.mjs          # 冻结「工具执行中插入的指令」的转发
├─ test/host-integration.mjs       # 离线：推理等级 / 积分 / 思考 / 原地 patch / 统计路由
│                                  #       QODER_LIVE=1 时再跑真实 API 的一轮（需要 PAT）
├─ test/client-credits-smoke.mjs   # 离线：用 React 桩渲染积分徽标 / 面板 / 表单字段
└─ node_modules/                   # 两个 MIT 依赖（见下）
```

自测（不需要网络，也不需要真 PAT）：

```bash
node test/test-smoke.mjs
node test/test-client.mjs
node test/test-abandoned-pause.mjs
node test/test-steering.mjs
node test/host-integration.mjs
node test/client-credits-smoke.mjs

# 真实账号冒烟（读 ~/.dsh/.credentials.yaml 里的 QODER_API_KEY，会消耗极少量积分）
QODER_LIVE=1 node test/host-integration.mjs
```

任一用例失败都会返回非 0 退出码，可直接放进 CI。

### 为何 `node_modules/` 会进仓库

插件需要 `@deepseek-ai/schemastery`（配置 schema）与 `@deepseek-ai/cosmokit`，
但宿主并没有把这两个包当作对外开放的依赖暴露给插件。为了不依赖宿主内部目录
结构，仓库直接带上了它们的 **MIT 发行版**（LICENSE 文件齐全，共 17 个文件 / 约 136 KB）。
如果你不想提交第三方源码，删掉 `node_modules/@deepseek-ai` 后自行确保这两个包
能被插件解析到即可。

## 卸载

从 profile 的 `package.json` 移除 `@local/dsh-plugin-qoder` 依赖与 `bundles`
条目，再执行 `pnpm install`，重启 dsh 即可。
