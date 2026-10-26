# 提示词润色按钮 · 实现说明书（可复刻版）

> 目标读者：要在另一个宿主（DeepSeek Harness 或类似 Web 聊天前端）上**从零实现同样功能**的 AI 或工程师。
>
> 本文档给出完整的**行为契约、提示词原文、数据结构、边界处理**。照做可得到行为一致的产品；不必照抄代码，但**不应改动提示词的语义**，否则输出风格会漂移。
>
> 参考实现就在本仓库：`src/index.js`（Host 半边）、`src/client.js`（Client 半边）。
> 文档里的代码片段是**形状说明**，行号与最终文件不必逐行对应。

---

## 0. 一句话定义

在聊天输入框的工具栏右侧加一个图标按钮。点击时，取当前输入框里的**草稿文本**，连同**最近几轮对话上下文**和**一个风格指令**，作为**一次独立的、单轮的 LLM 调用**发给模型，模型返回一段改写后的提示词，用它**替换掉草稿**。整个过程不产生对话消息、不写入会话历史。

---

## 1. 为什么要这样做（设计原理）

### 1.1 核心判断：润色必须是"旁路调用"

**错误做法**：把草稿作为用户消息发进当前对话，让模型回复改写版本。
**为什么错**：

- 会在对话历史里留下两条无用消息，污染上下文，后续每一轮都要为它们付 token
- 会触发 Agent 的工具调用、任务分解等行为（模型以为用户要它干活）
- 会干扰会话的 turn / step 结构

**正确做法**：调用 LLM 的**裸推理接口**，指定 provider / model / messages，自行拼装 system + user，拿到文本即丢弃请求。这次调用对会话透明。

### 1.2 核心判断：模型不能由用户另选

按钮用的模型必须等于**这条对话正在用的模型**。

理由：

- 用户已经在对话里选好了模型（可能是便宜的 flash，也可能是贵的推理模型），润色是"顺手"动作，不该让用户再选一次
- 用同一个模型，改写结果与后续该模型实际执行时的"理解"一致
- 用户在对话中切换模型后，润色应自动跟随

**实现**：读取该会话的 `modelSelection` 投影（持久化的模型选择），取其 `pending ?? lastUsed`。兜底顺序见 §4.3。

### 1.3 核心判断：约束写在提示词里，不在模型里

所有改写规则（不替你执行、保持语言、只输出结果、不许编造）都是**明文 prompt 约束**。这样换任何模型、任何版本，行为一致，可审计。

### 1.4 核心判断：保真必须有代码层兜底

**问题**：模型改写时容易"越写越走样"——丢掉版本号、把 `fetchUserData` 写成 `fetchUser`、把"不要改 X"改没了、或者膨胀三倍。

**提示词里的约束靠不住**（模型可能忽略）。所以加一道**代码校验**：

1. 用正则从原文提取"硬事实"（版本号、路径、URL、反引号代码、引号内文本、camelCase/snake_case 标识符、多位数字）
2. 检查每个硬事实是否**逐字且大小写一致**地出现在改写结果里
3. 检查长度是否超过该风格的膨胀上限
4. 任一不通过 → 带**具体缺失项列表**重试**一次**
5. 重试仍不通过 → 返回 `fidelity_failed`，保留原草稿；重试调用失败也按失败处理

**这是一道闸，不是重写循环**。最多重试一次，避免延迟失控。

### 1.5 核心判断：上下文只用来消歧，不用来改写

草稿里常有"把它改成 TypeScript""这个 bug 怎么修"这类**指代**。没有上下文，模型只能输出泛化版本。

所以取最近 N 轮对话作为上下文。但必须**明确告诉模型**：这段上下文只用来解析指代，**不要改写它、不要回答它、不要重复它**——否则模型会开始改写历史对话。

---

## 2. 用户可感知的行为契约

### 2.1 按钮位置

输入框（composer）工具栏的**右侧、模型选择器左边**。

以 DeepSeek Harness 为例，注册进 slot `conversation.input.right`（语义：*Compact controls before the composer submit action*），`order: 20`，使其排在模型选择器之前。

### 2.2 按钮外观（对齐 Work Buddy 的 enhance 按钮）

| 属性 | 值 |
|---|---|
| 尺寸 | 32 × 32 px，`border-radius: 50%` |
| 背景 | `transparent` |
| 默认色 | `--dsw-alias-label-secondary` |
| hover 背景 | `--dsw-alias-interactive-bg-hover` |
| active | `opacity: 0.8` |
| disabled | `opacity: 0.4`，`cursor: not-allowed` |
| 图标 | 16 × 16 SVG，`currentColor`，`fill-opacity: 0.7` |
| 图标形状 | "双星火花"：一大一小两颗四角星 |

**必须有三种视觉状态**：

| 状态 | 图标 | tooltip |
|---|---|---|
| idle | 双星火花 | `润色提示词 · 平衡` |
| loading | 转圈（圆环 `stroke-dasharray: 28 10`，1s 线性旋转） | `润色中…` |
| revert | 逆时针箭头 | `恢复原文` |

### 2.3 交互规则

| 触发 | 行为 |
|---|---|
| 左键点击（idle，草稿非空） | 发起润色，进入 loading |
| 左键点击（loading） | **取消**，中止请求，草稿恢复原样 |
| 左键点击（revert） | **恢复原文**，回到 idle |
| **右键点击** | 打开风格菜单 |
| 菜单项点击 | 切换风格，写入 localStorage，关闭菜单 |
| 草稿为空 | **按钮隐藏**（不渲染） |
| 会话正在提交/裁决中 | 按钮 disabled |
| 润色成功后手动编辑草稿 | **撤销备份作废**，revert 态回到 idle |
| 润色失败 | 草稿**不变**，tooltip 显示错误原因 |

### 2.4 风格菜单

四档，默认 `balanced`：

| id | 中文 | 英文 |
|---|---|---|
| `balanced` | 平衡 | Balanced |
| `concise` | 精简 | Concise |
| `detailed` | 详细 | Detailed |
| `code` | 代码 | Code |

菜单要求：

- 定位在按钮**上方**（`bottom: calc(100% + 8px)`），右对齐
- 当前档位前打 `✓`，文字用品牌色
- 标题行：`润色风格（右键切换）`
- Esc 关闭 / 点击外部关闭 / 窗口失焦关闭 / 键盘 `Shift+F10` 或菜单键打开
- 选中值持久化到 `localStorage`，key = `dsh-prompt-polish.style`
- 读取失败（隐私模式/配额满）静默回落到默认值，不影响功能

---

## 3. 数据契约

### 3.1 请求（浏览器 → Host）

```http
POST /dsh-prompt-polish/polish
Content-Type: application/json
```

```json
{
  "text": "用户当前输入的草稿原文",
  "style": "balanced",
  "context": true,
  "sessionId": "session-xxxx"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | 是 | 草稿原文；`trim()` 为空则拒绝 |
| `style` | string | 否 | 四档之一；非法值回落 `balanced` |
| `context` | boolean | 否 | 默认 `true`；显式 `false` 时跳过上下文 |
| `sessionId` | string | 否 | 用于解析模型与读上下文；缺失则走兜底 |

**请求体上限 256 KiB**，超出直接 400。

### 3.2 响应（Host → 浏览器）

成功：

```json
{
  "ok": true,
  "text": "改写后的提示词",
  "provider": "workbuddy",
  "model": "deepseek-v4.1-flash",
  "style": "balanced",
  "fidelity": "ok",
  "contextUsed": true
}
```

成功响应的 `fidelity` 有两个取值：

| 值 | 含义 |
|---|---|
| `ok` | 首轮通过保真闸 |
| `corrected` | 首轮未过，重试后通过 |

失败：

```json
{ "ok": false, "code": "no_model", "error": "No model is available for this conversation" }
```

| code | 场景 |
|---|---|
| `empty_input` | 草稿为空 |
| `no_model` | 找不到可用模型 |
| `llm_error` | 模型调用失败 |
| `aborted` | 超时/取消 |
| `empty_result` | 模型返回空文本 |
| `fidelity_failed` | 一次修正后仍未通过保真闸，保留原草稿 |
| `invalid_request` | 请求体非法或超限 |
| `internal` | 未捕获异常 |

**所有响应 HTTP 状态码均为 200**（除 400/404/405/500 这类协议错误），业务成败看 `ok` 字段。

---

## 4. 提示词（逐字，不要修改语义）

### 4.1 System Prompt

```text
You are a Prompt Engineering Expert specializing in improving user prompts for a development code assistant. When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose.

TASK: Analyze the draft under USER INPUT and rewrite it into a more effective prompt.

ANALYSIS PROCESS:
Identify the main objective, note any ambiguities or gaps, assess the clarity of instructions, and check for missing context.
Apply these prompt engineering principles: write clear, specific instructions; include necessary context; set explicit parameters and constraints; structure the expected output; remove redundant information.
Create the enhanced version: maintain the original goal and keep it realistic in the features it adds.
Do NOT request guides/how-tos unless the user asks. Do NOT suggest specific technologies unless mentioned in the user's prompt. Do NOT explain HOW to do things, focus on WHAT. Do NOT answer the request — rewrite it to be more specific.

FIDELITY GUARD (mandatory):
1. Every concrete fact in the original must survive verbatim: numbers, versions, names, file paths, URLs, code identifiers, quoted strings, and every explicit requirement or constraint.
2. Never invent facts, requirements, technologies, libraries, or acceptance criteria the original does not imply.
3. Never drop, soften, or contradict a stated constraint.

IMPORTANT CONSTRAINTS:
1. Language matching is the highest priority — respond in the exact same language as the user's input, and keep a natural mix if the input mixes languages.
2. Keep the rewrite concise and free of padding.
FORMAT: Provide only the rewritten prompt with no additional commentary.
```

**每条约束的作用**（复刻时不要随意删）：

| 句子 | 防的是什么 |
|---|---|
| `Do NOT answer the request — rewrite it` | 模型直接执行任务而不是改写 |
| `Do NOT suggest specific technologies unless mentioned` | 模型擅自加 Next.js / PostgreSQL 等 |
| `Do NOT explain HOW to do things, focus on WHAT` | 输出变成教程 |
| `FIDELITY GUARD` 三条 | 丢事实、编事实、软化约束 |
| `Language matching is the highest priority` | 中文输入回英文 |
| `Provide only the rewritten prompt` | 加"以下是改写后的版本："这类前言 |

### 4.2 User Prompt（模板）

`{input}` 与 `{context}` 是两个占位符，按 §4.4 规则填充。

```text
You are a prompt enhancement assistant. Improve the user prompt while preserving its intent and language.

USER INPUT:
{input}
{context}

TASK:
Rewrite the user input into a clearer, more specific prompt for the target AI assistant.

CRITICAL PRIORITY - LANGUAGE CONSISTENCY:
1. You MUST detect the language of the user input above and write the enhanced prompt in that same language.
2. If the user writes in Chinese, the enhanced prompt MUST be entirely in Chinese.
3. If the user writes in English, the enhanced prompt MUST be entirely in English.
4. If the user writes in any other language, the enhanced prompt MUST use that exact same language.
5. If the user mixes languages, keep a natural matching mix. Do not translate the user's intent into a single language.
6. These language rules are behavior instructions only; never include language analysis or language labels in the output.

ENHANCEMENT REQUIREMENTS:
1. Return only the enhanced prompt text; do not add explanations, prefaces, markdown fences, labels, or analysis.
2. Do not include language labels or meta notes such as "User input is in Chinese".
3. Preserve the user's original intent, topic, constraints, and target output type. Do not answer the request.
4. Always make a substantive enhancement when possible: clarify the task, scope, constraints, and expected output.
5. If the original prompt is already clear, lightly polish it instead of returning it unchanged.
6. Keep the enhanced prompt complete and concise. Do not end with an unfinished list, dangling conjunction, or trailing colon.
7. Do not add unrelated requirements, unsupported facts, or unnecessary sections.

EXAMPLES:
User input (Chinese): "请帮我解释这段代码的功能"
Enhanced prompt: "请解释这段代码的主要功能、执行流程和关键逻辑，并指出可能需要注意的边界情况。"

User input (English): "Please explain what this code does"
Enhanced prompt: "Explain what this code does, including its main purpose, key control flow, and any important edge cases."
```

> 第 6 条（不要以未完成的列表/悬空连词/冒号结尾）防的是模型输出被 max_tokens 截断后留下"包括以下方面："这种半截话。
>
> 第 2 条与语言规则第 6 条**必须成对存在**：只禁"输出语言标签"不够，模型还会写"用户输入是中文，所以回复中文"这种元注释。

### 4.3 风格指令块（追加在 user prompt 末尾）

四档的指令原文：

```text
STYLE: Balanced. Make the prompt clear and specific — state the task, its scope, the constraints, and the expected output — in roughly the same length as the original. Do not pad it with requirements the original does not imply.
```

```text
STYLE: Concise. Keep the rewrite as short as possible while removing ambiguity: one compact paragraph or a few short points. Cut every word that does not add meaning.
```

```text
STYLE: Detailed. Expand into a structured prompt with explicit parts for task, context, constraints, and expected output format. Prefer short labelled lines over long prose.
```

```text
STYLE: Code-oriented. Frame the request for a coding assistant: name the language or runtime only when the original implies it, specify inputs, outputs, edge cases, and how the result is verified. Do not invent libraries, APIs, or versions.
```

对应长度上限（供保真闸使用）：

| 风格 | 增长倍率 | 绝对上限公式 |
|---|---|---|
| `concise` | 1.2 | `round(len × 1.2) + 120` |
| `balanced` | 1.6 | 同上 |
| `code` | 1.9 | 同上 |
| `detailed` | 2.2 | 同上 |

`+120` 是给小草稿的固定余量（否则 10 个字的输入只能写 12 个字）。

### 4.4 拼装顺序（严格按此顺序）

```js
basePrompt =
  USER_PROMPT
    .replace('{input}', 草稿原文)
    .replace('{context}', 上下文块 === '' ? '' : '\n\n' + 上下文块)
  + '\n\n' + 风格指令块
```

即：**user prompt 全文 → 两个空行 → 风格指令**。

若保真闸首轮判定失败，第二次调用为：

```js
retryPrompt = basePrompt + '\n\n' + 修正指令块
```

---

## 5. 上下文块（Context Block）

### 5.1 格式

```text
RECENT CONVERSATION (context only — do not rewrite it, answer it, or repeat it; use it only to resolve references such as "it", "this", or "the above"):
user: 我在做一个 DSH 插件，Host 半边负责路由……
assistant: 你的 Host 半边读 modelSelection 投影这段没问题……
```

### 5.2 提取规则

| 项目 | 规则 |
|---|---|
| 来源 | 会话日志尾部最近 **80 条事件**（`CONTEXT_EVENT_TAIL = 80`） |
| 采信事件 | 仅 `user/message` 与 `assistant/message` |
| **过滤** | `user/message` 必须 `source.kind === 'user'`（排除模型切换通知、goal 续跑、命令回显）；`assistant/message` 必须 `source.kind === 'model'` |
| 取多少 | 从新到旧挑选最近 **6 条**，分配预算后按时间正序输出（`CONTEXT_MESSAGES = 6`） |
| 单条长度 | 截断至 **400 字符**（`CONTEXT_MESSAGE_CHARS = 400`），超出加 `…` |
| 总长度 | 累计封顶 **1500 字符**（`CONTEXT_TOTAL_CHARS = 1500`） |
| 空处理 | 无历史 / Session 不存在 / 读失败 → 返回空串，`{context}` 位置留空 |

### 5.3 为什么要过滤 source.kind

会话日志里混着大量"不是对话"的消息：

- `model-selection` 通知（"此点之前的助手回合由 A 生成，之后改用 B"）
- `goal` 自动续跑的用户消息
- slash 命令回显

把这些当上下文喂给模型，会让它误判"用户在要求什么"，产生莫名其妙的改写。

---

## 6. 保真闸（Fidelity Guard）

### 6.1 硬事实提取正则

```js
const FACT_PATTERNS = [
  /https?:\/\/[^\s)>\]]+/gu,                  // URL
  /`([^`\n]{2,120})`/gu,                      // 反引号代码
  /"([^"\n]{2,120})"/gu,                      // 双引号内文本
  /'([^'\n]{2,120})'/gu,                      // 单引号内文本
  /“([^”\n]{2,120})”/gu,                      // 中文引号内文本
  /(?:[A-Za-z]:)?[\\/]?[\p{L}\p{N}_.@-]+(?:[\\/][\p{L}\p{N}_.@-]+)+/gu, // 含中文的绝对或相对路径
  /[\p{L}_][\p{L}\p{N}_@-]*\.(?:[A-Za-z][A-Za-z0-9]*)(?:\.[A-Za-z0-9]+)*/gu, // 文件名
  /\b\d+(?:\.\d+){1,}\b/gu,                   // 版本号 18.3.1
  /\d+/gu,                                    // 含单个数字的数量
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/gu,            // camelCase
  /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/gu,          // snake_case
]
```

- 捕获组存在时取 `match[1]`，否则取 `match[0]`
- 空 token 丢弃；单个数字保留
- 去重后**按长度降序**排列（便于报告）

> **注意**：故意**不**提取普通英文/中文词。那些正是改写要动的东西。只抓"改动即失真"的实体。

### 6.2 判定

```js
missing = 原文每个事实 token，若 !改写结果.includes(token)
limit   = round(max(原文.trim().length, 1) × 增长倍率) + 120
overBudget = 改写结果.length > limit
ok = missing.length === 0 && !overBudget
```

**大小写敏感**，也不做模糊匹配（`fetchUserData` 不能匹配 `fetchuserdata` 或 `fetchUser`）。普通自然语言约束仍由提示词约束，代码闸并不证明语义等价。

纯数字和标识符还要检查边界：`3` 不能匹配 `30`，`fetchUserData` 不能匹配 `fetchUserDataCached`。

### 6.3 修正指令

```text
CORRECTION — the previous rewrite failed the guard. Apply it exactly:
1. These exact tokens from the original are missing. Put every one of them back verbatim, unchanged: «React 18.3.1», «src/App.tsx», «fetchUserData»
2. The rewrite was too long. Keep it at or under 512 characters — the original is 87. Remove padding rather than requirements.
3. Return only the corrected prompt, with no commentary.
STYLE (unchanged): STYLE: Balanced. ...
```

- 第 1 条**仅在 `missing` 非空时**出现，缺失项用 `«»` 包裹
- 第 2 条**仅在 `overBudget` 时**出现，带上具体数字
- 第 3 条固定
- 末尾**重述风格指令**，防止重试时风格漂移

---

## 7. 模型调用

### 7.1 模型选择兜底链

按顺序尝试，取第一个**provider 已注册**的：

1. **Session 的模型选择投影**：`sessionProjections.stateOf(session, 'modelSelection')` → `pending ?? lastUsed` → `{ provider, model, reasoningEffort? }`
2. **客户端上报的选择**（请求体里的 `provider` / `model` / `reasoningEffort`）
3. **Profile 默认选择**：`agentDefaultModel.currentSelection()`

第 1 条是主路径。第 2、3 条是兜底（Session 未绑定 Agent、或投影尚未建立时）。

**provider 已注册校验**：`llm.listProviders()` 里存在该 provider；空数组表示没有可用 provider，返回 `no_model`。

### 7.2 推理强度（reasoningEffort）

只在**该模型确实声明支持**时才传：

```js
info = await llm.resolveModelInfo(provider, model)
efforts = info?.reasoning?.efforts
if (!efforts?.some(e => e.id === requested)) return undefined   // 不传
```

**为什么**：对无 reasoning 元数据的模型显式传 effort，会直接抛 `UNSUPPORTED_REASONING_EFFORT`，被适配器折成空流，表现为"模型没返回文本"。查询失败也一律不传。

### 7.3 调用参数

```js
{
  provider,                      // 见 7.1
  model,                         // 见 7.1
  sessionId: 'dsh-prompt-polish',// 固定调用身份，不是真实会话 ID
  system: SYSTEM_PROMPT,
  messages: [userMessage(prompt)],// 单条 user 消息
  temperature: 1,
  reasoningEffort,               // 仅在 7.2 通过时出现
  signal: requestSignal,        // 断开连接即取消，首次调用和重试共用 60 秒上限
}
```

**关键点**：

- `sessionId` 用**固定字符串**而非真实会话 ID。某些适配器会拿它做请求头（如 `x-opencode-session`），给固定值既能满足适配器，又不会把这次调用计入真实会话的配额/统计。
- `messages` **只有一条 user 消息**，不塞历史。历史已在 §5 里作为文本压进 prompt 了。
- `temperature: 1`（宿主默认值即可，不要调低——改写需要一定发散）。
- **不设 `maxTokens`**：推理模型把思考算进输出预算，显式小上限会截断正文。

### 7.4 流式收集

```js
let output = ''
let finish
for await (const chunk of llm.stream(options)) {
  if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text
  else if (chunk?.type === 'finish') finish = chunk.reason
}
```

**必须检查 `finish`**：

| `finish.kind` | 处理 |
|---|---|
| `stop` / `max-tokens` / 缺省 | 正常，继续 |
| `error` | 返回 `{ ok: false, code: 'llm_error', error: finish.failure.message }` |
| `aborted` | 返回 `{ ok: false, code: 'aborted' }` |

> 宿主把适配器的异常**折进终止块**，不会从 `for await` 抛出。不检查 `finish` 会把失败当成"模型返回空文本"。

### 7.5 输出清洗

```js
function cleanResult(text) {
  let out = text.trim()
  // 模型偶尔仍然包一层 ``` 围栏
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/u.exec(out)
  if (fenced !== null) out = fenced[1].trim()
  // 去掉包裹的引号（含中文引号）
  out = out.replace(/^["'“”‘’]|["'“”‘’]$/gu, '').trim()
  return out
}
```

清洗后为空 → `{ ok: false, code: 'empty_result' }`。

---

## 8. 关键边界（易漏，逐条对照）

| # | 场景 | 必须的行为 |
|---|---|---|
| 1 | 草稿为空 | 按钮**不渲染**（返回 null），不是 disabled |
| 2 | 润色中再次点击 | **取消请求**，草稿保持原样，回 idle |
| 3 | 润色成功后用户手改草稿 | **撤销备份作废**，revert 态回 idle |
| 4 | 撤销备份比对 | 用原样文本比较，手动修改空白也会使备份失效 |
| 5 | 写入草稿后立刻比对 | 设一个 "awaiting apply" 标志；观察到草稿等于结果后再开始判断"用户是否改动"，否则刚写入就被误判为已改动 |
| 6 | 请求竞态 | 校验请求身份、原草稿、会话和提交状态；变更即取消，旧结果丢弃 |
| 7 | 组件卸载 | cleanup 中取消并清除请求身份，忽略迟到响应 |
| 8 | 模型返回带前言 | 靠 prompt 约束 + `cleanResult` 兜底 |
| 9 | 模型返回空 | `empty_result`，**不动草稿** |
| 10 | 找不到模型 | `no_model`，**不动草稿**，tooltip 显示原因 |
| 11 | 首轮保真失败但重试也失败 | 返回失败，保留原草稿；重试结果未通过时为 `fidelity_failed` |
| 12 | localStorage 不可用 | 静默回落到默认风格，功能不受影响 |
| 13 | 会话正在提交/裁决 | 按钮 disabled（`phase === 'adjudicating' \|\| 'submitting'`） |
| 14 | 上下文读不到 | `{context}` 留空，照常润色，`contextUsed: false` |
| 15 | 请求体超 256 KiB | 400，不调模型 |

### 8.1 "修改即失效"的精确实现

这是最容易做错的地方。伪代码：

```js
// 写入改写结果时
awaitingApplyRef.current = true
setDraft(polished)
setBackup({ before: original, after: polished })

// 草稿变化时判断
useEffect(() => {
  if (backup === undefined) return
  const same = text === backup.after
  if (awaitingApplyRef.current) {
    if (same) awaitingApplyRef.current = false   // 观察到写入生效，退出等待
    return
  }
  if (same) return                               // 仍是模型版本，保留备份
  setBackup(undefined)                           // 用户改了，作废备份
  setStatus(cur => cur === 'revert' ? 'idle' : cur)
}, [text, backup])

```

**没有 `awaitingApplyRef` 会怎样**：`setDraft` 是异步进编辑器的，那一刻 `text` 还是旧值，与 `backup.after` 不等，于是立刻把备份清了——revert 按钮一闪就没。

---

## 9. 参考实现的文件结构

```
dsh-prompt-polish/
├── package.json        # bundle 清单：dsh.bundle.patch + dsh.client
├── cordis.patch.yml    # 插入一行 Host 插件
├── src/
│   ├── index.js        # Host 半边：HTTP 路由 + 提示词 + LLM 调用 + 保真闸
│   └── client.js       # Client 半边：按钮 + 风格菜单 + 状态机
├── locale/en.json      # 插件市场展示用（meta.title / meta.description）
├── locale/zh.json
├── assets/icon.svg     # 插件图标（≤256 KiB，SVG/PNG/JPEG/WebP）
├── scripts/check.mjs   # 零依赖自检
└── docs/               # 本文档
```

- `src/index.js` 约 580 行，`src/client.js` 约 450 行，**零第三方依赖**
- Host 半边**不要** `import` 宿主的包：工作区安装的 bundle 用自身路径解析裸导入，会失败。所需原语（消息对象、chunk 累积）按宿主文档的**普通对象形状**手写即可
- Client 半边通过 `window.__ModuleLoader__.load({ id, factory })` 注册，React 从 `require('react')` 取

---

## 10. 自测清单

实现完后按此逐条验证（都可脚本化）：

| # | 验证 | 期望 |
|---|---|---|
| 1 | 无草稿 | 按钮不存在于 DOM |
| 2 | 输入草稿 | 按钮出现，图标为双星火花 |
| 3 | 点击 | 出现旋转图标，请求发出 |
| 4 | 成功 | 草稿被替换，按钮变逆时针箭头 |
| 5 | 点箭头 | 草稿恢复原文 |
| 6 | 润色后手改一个字 | 箭头变回火花 |
| 7 | 右键 | 菜单弹出，当前档位带 ✓ |
| 8 | 换风格再润色 | 输出结构明显不同（精简最短、详细最长） |
| 9 | 刷新页面 | 风格保持上次选择 |
| 10 | 输入含 `React 18.3.1` `src/App.tsx` `fetchUserData` 的草稿 | 三者逐字保留且大小写一致，否则返回失败且不覆盖草稿 |
| 11 | 同一草稿开关 `context` | 开时能解析"它"，关时输出泛化 |
| 12 | 在对话里切换模型后润色 | 返回的 `provider`/`model` 与新模型一致 |
| 13 | 断网点击 | 草稿不变，tooltip 显示错误 |
| 14 | 润色中点击 | 请求中止，草稿不变 |

---

## 11. 可直接复用的提示词片段

若只在**单轮工具**里用（不做完整插件），最小可用集是：

```text
[System]
You are a Prompt Engineering Expert specializing in improving user prompts for a
development code assistant. Rewrite the user's draft into a clearer, more specific
prompt while maintaining its core purpose. Do NOT answer the request — rewrite it.
Do NOT invent technologies, libraries, or versions the draft does not mention.
Every concrete fact must survive verbatim (numbers, versions, paths, URLs, identifiers,
quoted strings, explicit constraints). Respond in the exact same language as the input.
Return only the rewritten prompt, with no commentary.

[User]
{草稿}
```

这段在多数模型上都能得到 80% 的效果；加上 §4 的完整版、§5 的上下文、§6 的保真闸，才达到生产可用。

---

## 12. 与 Work Buddy 原版的差异

原版（Work Buddy / CodeBuddy 桌面端）的 enhance prompt 是本实现的基础。这是有意保留的对照表，便于判断哪些改动是必要的：

| 维度 | Work Buddy 原版 | 本实现 |
|---|---|---|
| System prompt 骨架 | 角色 + 分析流程 + 语言优先 + 800 字 + 只输出结果 | **沿用**，去掉了开头与 TASK 的重复段落 |
| 长度约束 | 硬编码"约 800 字符" | 改为按风格的增长倍率，可由代码校验 |
| 保真 | 仅提示词要求"preserve intent" | 提示词 + **正则校验 + 一次重试** |
| 上下文 | 无 | 最近 6 条（≤1500 字），明确限定"只用于消歧" |
| 风格 | 无 | 四档，右键切换，localStorage 持久化 |
| 模型 | 随对话（`enhanceSelectedModelId`） | **一致**，读 Session 的 `modelSelection` 投影 |
| 传输 | 主进程 → sidecar HTTP → LLM | Host 半边注册 HTTP 路由 → `llm.stream()` |
| 位置 | 输入工具栏右侧、模型选择器左 | **一致**（slot `conversation.input.right`，order 20） |
| 撤销 | 有（backupBlocks + 内容分歧检测） | **一致**，且补充了 `awaitingApplyRef` 防误判 |
| 取消 | 有 | **一致**（AbortController） |
| 状态图标 | 火花 / 转圈 / 逆时针箭头 | **一致**（同一套 SVG 路径与尺寸） |
