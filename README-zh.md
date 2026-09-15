# dsh-approval-review

[English](README.md) | [简体中文](README-zh.md)

**DeepSeek Harness 的 Codex 风格 Agent 自动审批。** 当某个动作要越过沙箱自身覆盖不到的边界时，由一个独立的复核模型阅读待执行的动作并给出裁决——日常操作不再打扰人，危险操作也漏不过去。每一次裁决都会在独立的审计卡页里留下完整理由。

本插件实现的是 Codex [Auto-review](https://developers.openai.com/codex/concepts/sandboxing/auto-review) 的形态：把交互式审批请求交给复核者而不是人；复核者返回结构化裁决；否决不是一句干巴巴的报错，而是把理由交还给调用模型；同一回合内的连续否决会触发熔断，避免 Agent 在升级请求上打转。

> **它只是换了"谁来审"，没有放宽任何权限。** 插件不会扩大沙箱、不会凭空发放授权，也不会把本该由人决定的事从人手里拿走。它不负责的请求一律通过 `next()` 原样交还给应答链。

## 能力一览

| | |
|---|---|
| **走官方缝** | 注册在 `approval/request` 上的应答者，用 `prepend: true` 排在人类 UI 应答者之前，只认领自己策略范围内的请求，其余全部交还。 |
| **第二个模型复核** | 复核者跑成**只读子代理**（`fork`），工具白名单只有 `read`/`glob`/`grep`，所以它能真去**读工作区**——"这个路径到底在不在仓库里"从猜测变成事实。`mode: direct` 可退回纯模型调用。 |
| **失败即拒绝** | 复核崩溃、超时、输出被截断或不符合 schema 时走配置的失败策略，默认 `rejected`。证据不足永远不会变成放行。 |
| **理由回到模型** | 否决理由会追加到被拒的工具结果里，并明确要求模型不得绕道重试同一目标。 |
| **风险闸门** | 裁决为 `allow` 但风险高于 `maxAutoAllowRisk` 时不会自动放行，而是转人工。 |
| **熔断** | 连续否决与滑动窗口否决双阈值，对齐 Codex 的同回合熔断；触发后本回合后续请求转人工。 |
| **预算** | 每回合复核调用上限，避免死循环把复核费用刷爆。 |
| **一次性放行** | `/approval-review approve [n]` 为人工作一次重试授权。复核者仍独立裁决，只是会看到这条人工授权。 |
| **composer 第二轴** | composer 工具行里一个 `自动审批 · 人工 / AI` 芯片，紧挨访问模式芯片。和 Codex 一样，"谁来裁决"是**独立于**"能动多少"的另一根轴，不是第四个沙箱预设。 |
| **裁决缓存** | 相同的 `tool + arguments` 复用近期裁决，重试循环不会每次都烧一次复核调用。仅在 `context.turns` 为 0 时启用——那时裁决才真正可从动作本身重放。 |
| **失败预算** | 每回合复核**失败**次数上限，避免复核持续崩溃时无限重试、把请求卡住。 |
| **审计卡页** | 会话头部的卡页，逐条展示工具、裁决、风险等级、理由、更安全的替代建议、复核路由、耗时，以及实时的预算与熔断状态，并带真正可用的开/关与一次性放行按钮。 |

## 安装

```sh
# npm 发布版
dsh plugin --profile <profile> add dsh-approval-review

# 本地目录
dsh plugin --profile <profile> add /path/to/dsh-approval-review

# git 钉版本
dsh plugin --profile <profile> add "github:LAwLi3tCoding/dsh-approval-review#<sha>"
```

重启后确认配置行已经组装进去：

```sh
dsh --profile <profile> --dump-config | grep -A6 'id: approval-review'
```

桌面 profile 由 Electron 应用独占管理，会拒绝 `dsh plugin`；请手动添加依赖与 bundle 条目，或用应用内的插件管理入口。

## 配置

所有可调项都在 bundle 的 `cordis.patch.yml` 那一行里，不必改代码。**按 id 覆盖会整行替换配置**——要保留的键必须全部重述，否则省略的键会静默回到 schema 默认值。

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关。`false` 时插件仍挂载但不认领任何请求。 |
| `enabledByDefault` | `true` | 会话初始的运行时开关状态。 |
| `reviewTools` | `[bash, pwsh, write]` | 送往复核者的工具名 glob。 |
| `defaultPolicy` | `human` | 未命中 glob 的工具走哪种策略：`ai` / `human` / `never`。 |
| `rules` | `[]` | 有序的 `{pattern, policy, field?, note?}` 正则规则，优先于工具表求值。`field` 可为 `reason`（默认）、`toolName`、`arguments`。 |
| `reviewer.mode` | `subagent` | `subagent` 跑只读子代理（能读工作区）；`direct` 走一次性纯模型调用。 |
| `reviewer.provider` / `.model` | *(继承)* | 复核路由；不填则继承调用 Agent 自己的路由。 |
| `reviewer.subagentProvider` | `fork` | `mode: subagent` 用的子代理后端（`fork` / `spawn`）。 |
| `reviewer.tools` | `[read, glob, grep]` | 复核子代理的工具白名单。留空会回退到只读默认，而不是继承父代理的全部工具。 |
| `reviewer.timeoutMs` | `60000` | 单次复核的硬超时。 |
| `reviewer.maxTokens` | `1024` | 输出上限。 |
| `reviewer.temperature` | `0` | 采样温度。 |
| `reviewer.policyText` | *(内置策略)* | 替换裁决策略正文。 |
| `reviewer.guidance` | *(无)* | 追加在策略之后的部署专属指引。 |
| `reviewer.argumentMaxChars` | `4000` | 单个参数值的字符上限。 |
| `reviewer.argumentsBudgetChars` | `16000` | 整份参数文档的字符上限；`0` 关闭。 |
| `context.turns` | `2` | 作为证据的历史回合数；`0` 表示不发送。 |
| `context.maxChars` | `6000` | 证据片段字符预算。 |
| `context.includeAssistant` | `true` | 是否包含助手消息。 |
| `context.includeToolActivity` | `true` | 是否包含工具调用与结果。 |
| `maxAutoAllowRisk` | `medium` | 允许复核者自动放行的最高风险。 |
| `onRiskExceeded` | `delegate` | 超过该上限时：`allow` / `delegate` / `deny`。 |
| `onUncertain` | `delegate` | 复核者表示无法判断时。 |
| `onReviewerFailure` | `rejected` | 复核崩溃、超时或输出不合 schema 时。 |
| `budget.maxReviewsPerTurn` | `20` | 每回合复核调用上限。 |
| `budget.onExhausted` | `delegate` | 预算耗尽后：`delegate` / `deny`。 |
| `maxFailuresPerTurn` | `10` | 每回合复核**失败**次数上限，超过即转人工。 |
| `verdictCache.ttlMs` | `60000` | 相同动作复用裁决；`0` 关闭。仅在 `context.turns` 为 0 时生效。 |
| `verdictCache.maxEntries` | `256` | 缓存指纹条数上限，超出自淘汰最旧。 |
| `circuitBreaker.consecutiveDenials` | `3` | 连续否决多少次触发熔断。 |
| `circuitBreaker.windowDenials` | `10` | 滑动窗口内否决多少次触发；`0` 关闭该规则。 |
| `circuitBreaker.windowSize` | `50` | 滑动窗口大小。 |
| `circuitBreaker.action` | `delegate` | 熔断打开后：`delegate` / `deny`。 |
| `override.ttlMs` | `300000` | `/approval-review approve` 的有效期；`0` 表示不过期。 |
| `override.maxPending` | `10` | 放行指令最多能指向多少条最近的否决记录。 |
| `reasonMaxChars` | `2000` | 插件输出理由的字符上限。 |
| `feedReasonToModel` | `true` | 是否把理由追加到被拒的工具结果。 |
| `language` | `en` | `/approval-review` 输出语言（`en` / `zh`）。 |

### 三种工具策略

- **`ai`** —— 由本插件的复核者裁决，结果只会是 `allowed-once` 或 `rejected`。
- **`human`** —— 用 `next()` 交还给应答链，也就是原本的审批弹窗。插件不会短路它。
- **`never`** —— 直接 `rejected` 并附说明，不调复核、不弹窗。用于对某类工具做硬禁用。

`edit` 故意**没有**放进默认 `reviewTools`：原地修改已有文件是日常操作里后果最重的一类，在部署方明确决定之前，它继续走人工审批。

### 示例：更严格的部署

```yaml
- insert:
    - id: approval-review
      name: dsh-approval-review
      config:
        reviewTools: ['bash', 'pwsh', 'write', 'edit']
        defaultPolicy: human
        rules:
          - pattern: '(?i)(rm\s+(-[a-z]+\s+)*/|git\s+push\s+--force)'
            policy: never
            note: destructive
          - pattern: 'curl|wget|nc\s'
            policy: ai
            field: arguments
        reviewer:
          model: '<更便宜的复核模型>'
          timeoutMs: 30000
        maxAutoAllowRisk: low
        onRiskExceeded: delegate
        circuitBreaker: { consecutiveDenials: 2, windowDenials: 5, windowSize: 20, action: deny }
```

## 会话命令

```
/approval-review on|off|status|approve [n]
```

- **`on` / `off`** —— 持久化的会话开关。重启与恢复后依然有效，因为开关是从命令自身的会话事件里折叠出来的，而不是存在内存里。
- **`status`** —— 当前开关、本回合复核预算、连续否决数、累计次数、熔断是否打开、还有几条一次性放行待用，以及最近一次裁决。
- **`approve [n]`** —— 为最近第 n 条否决记录（1 为最近）登记一次性授权。该工具的下一次复核会带上这条人工授权作为上下文，但复核者依旧独立裁决。

## 审计卡页

包里的 `dsh.client` 声明会自动注册浏览器半边；只要 profile 提供会话投影能力，宿主侧就会注册 `approvalReview` 投影。不需要额外的 patch 行。

卡页从会话头部打开，逐条展示：工具名、裁决、风险等级、复核理由、可选的更安全替代建议、是哪条规则选中了策略、请求方自己的理由、复核路由与耗时、风险与不确定标记、可展开的参数视图，以及对最近否决记录的一键放行按钮。同时展示实时预算、连续否决数与熔断状态，以及等价的斜杠命令。

没有投影能力时，卡页会自报不可用，应答者不受影响。

## 工作原理

```text
              approval/request 应答链（waterfall）
               │
   ┌───────────┴──────────────────────────────────┐
   │ dsh-approval-review 应答者（prepend）          │
   │  · 插件开关与会话开关是否打开？                 │  否 ── next() ──▶ 人类应答者
   │  · 风险规则 → reviewTools → defaultPolicy      │
   │    = human？─────────────────────────────────┼── next() ──▶ 人类应答者
   │    = never？─────────────────────────────────┼── rejected + 标记
   │  · 熔断是否打开？─────────────────────────────┼── 转人工 / 拒绝
   │  · 本回合预算是否耗尽？───────────────────────┼── 转人工 / 拒绝
   └───────────┬──────────────────────────────────┘
               │ ai
               ▼
   ┌──────────────────────────────────────────────┐
   │ 复核者：一次性模型调用                        │
   │  · 证据：待执行动作 + 脱敏后的参数             │
   │    + 申请理由 + 有界对话片段                   │
   │  · 输出：{decision, risk, reason, suggestion}  │
   │  · 超时与请求 signal 竞速                      │
   └───────────┬──────────────────────────────────┘
               │ 裁决 | 失败（失败即拒绝）
               ▼
    放行 ─▶ allowed-once     否决 ─▶ rejected
                                    └▶ 理由追加到被拒的工具结果
                                       （tools/post-execute）
```

审批结果是封闭词表，装不下任何文字。所以插件把理由放到被拒的**工具结果**上（通过 `tools/post-execute` 监听器）。这一条通道同时服务两个目的：模型能读到为什么被拒；而折叠会话日志的审计账本也能把同一份理由还原出来给卡页用。

### 为什么审计账本不新增会话事件类型

持久化读取路径会拒绝解释含有 `KNOWN_SESSION_EVENT_TYPES` 之外事件类型的日志，除非该记录带有信封上的 `ignorable: true` 标记；而在已发布的任何版本里，`Session.append` 都无法盖上这个标记——只有拥有日志的 harness 本人可以。因此，插件若追加自己的 `approvalReview/*` 事件，会让该会话无法再恢复。

所以账本**不新增**任何事件类型。它折叠宿主本来就写的事件（`approval/asked`、`approval/decided`、`tool/call`、`step/*`、`turn/*`、`command/run`、`tool/result`）到一个固定的投影里，并从被拒的工具结果中还原复核理由。卡页上的每个字段都能仅凭日志重建。

## 安全说明

- **脱敏先结构化、再兜底文本。** 参数对象会被逐层遍历并替换命中密钥名的叶子；键名按词边界匹配，所以 `auth` 不会误伤 `author`。无法解析的负载退化为文本兜底擦除加长度截断。
- **对话片段走同一套脱敏。** 它读的是与"待执行动作"同一个 `tool/call` 事件；直接用原始参数字符串拼片段，等于把另一处刚遮住的凭据又交给复核模型。
- **复核者不是 Agent。** 它是一次不挂工具、不碰工作区的模型调用，因此即便复核者被攻破，也无法升级它所守卫的那道边界，更不会递归回它自己服务的应答者。
- **默认失败即拒绝。** `onReviewerFailure: rejected`、`onUncertain: delegate`、`maxAutoAllowRisk: medium` 是出厂选择：误拒一个安全动作的代价是一次重试，误放一个危险动作可能无法挽回。
- **它不是安全保证。** 它只评估审批缝真正提出的请求，而语言模型会犯错，在对抗性场景下尤其如此。它是配置良好的沙箱的补充，不是替代。

## 开发

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build       # tsdown：lib/index.js + lib/client.js
pnpm check       # 以上三项
```

测试是分层的：纯策略表、复核证据包与裁决解析、审计折叠、运行时护栏，以及一层集成测试——它挂载**真实的** `ApprovalService` 与 `LlmRuntime`，用可编排的适配器驱动真实的 `approval/request` 分发。集成层正是抓出对话片段凭据泄漏的那一层，所以扩展测试时优先从它入手。

## 许可证

Apache-2.0。
