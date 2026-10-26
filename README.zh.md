<div align="center">

<img src="assets/icon.svg" width="96" height="96" alt="Prompt Polish 图标">

# 提示词润色 Prompt Polish

**给 DeepSeek Harness 输入框加一个 Work Buddy 同款的「润色提示词」按钮。**

左键把你正在写的草稿改写成更清晰的提示词，用的就是当前对话已经在用的模型；右键切换风格。

[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-%E6%8F%92%E4%BB%B6-4f7cff)](https://github.com/deepseek-ai)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![无构建步骤](https://img.shields.io/badge/%E6%9E%84%E5%BB%BA-%E6%97%A0-success)](#为什么没有构建步骤)
[![运行时依赖](https://img.shields.io/badge/%E8%BF%90%E8%A1%8C%E6%97%B6%E4%BE%9D%E8%B5%96-0-success)](#依赖)

[English](README.md)

</div>

---

## 它做什么

按钮位于输入框右侧的控制位——也就是模型选择器前面那一个，和 Work Buddy 的位置一致——只做一件事：

把你正在看的这份草稿，改写成更有效的提示词。

- **用对话自己的模型。** 没有额外的模型选择器，也没有隐藏的默认值。Host 先读 Session 持久化的 `modelSelection` 投影，再读 Client 从模型位报上来的选择，最后才回落到 profile 默认值。无论落到哪一个，都是你本来就在用的那个模型。
- **四种风格**，右键切换，跨刷新记住：*平衡*（默认）、*精简*、*详细*、*代码*。
- **忠实度守卫，始终开启。** 原文里每一个具体事实——数字、版本号、路径、URL、引号内字符串、代码标识符——都必须原样保留，且改写不得超出该风格的长度预算。守卫失败只重试一次并附上明确纠正说明；它是闸门，不是循环。
- **对话上下文，始终开启。** 从 Session 日志读取最近几轮，让改写知道「它」指的是什么。除了你配置的 `llm` 服务，不往任何地方发数据。
- **一键还原。** 改写成功后按钮变成还原箭头，原文始终只差一次点击。一旦你编辑了结果，这份备份就被丢弃——已经没有可还原的内容了。

### 行为细节

| 状态 | 你会看到 |
| --- | --- |
| 草稿为空、也没改写成功过 | 按钮隐藏（与 Work Buddy 一致） |
| 草稿有内容 | 星芒图标；悬停显示提示语和当前风格 |
| 正在改写 | 转圈；再点一次取消并恢复草稿 |
| 改写成功 | 还原箭头；点击恢复原文 |
| 改写失败 | 草稿原样不动；原因显示在提示语里 |
| `adjudicating` / `submitting` 阶段 | 按钮禁用 |

风格菜单也支持 <kbd>Shift</kbd>+<kbd>F10</kbd> 或菜单键打开，点击外部、<kbd>Esc</kbd>、窗口失焦时关闭。

## 安装

```sh
dsh plugin --profile <你的profile> add /path/to/prompt-polish-github
```

或用插件管理器指向本目录。bundle 自带 `dsh.bundle.patch`，安装时一步插入 Host 行与 Client bundle，无需额外注册。

装好后下次输入框渲染时按钮就会出现。不需要重新构建，也不需要额外依赖——原因见下。

## 环境要求

- DeepSeek Harness，且输入框暴露 `conversation.input.right` 插槽与 `llm`、`webServer` 服务。
- Client bundle 注入了 `@deepseek-ai/dsh-client-ui-conversation` 与 `@deepseek-ai/dsh-client-locale`，因此需要这两个包在场（标准 Web/Desktop profile 自带）。

## 为什么没有构建步骤

两半都以纯 JavaScript 直接发布，这是刻意的：

- **Host 半边** 是 `src/index.js`，一个导出 `inject` 与 `apply` 的 ES 模块。它不从 Harness 包导入任何东西——workspace 安装的 bundle 会按 workspace 而不是运行中的安装来解析裸导入，所以它需要的那套很小的请求词汇，是照着 `llm` 服务文档里的纯对象形状自己拼的。
- **Client 半边** 是 `src/client.js`，一个经典脚本，用 `window.__ModuleLoader__.load({ id, factory })` 自行注册，并通过 loader 的模块表解析 `react`。

没有打包器，没有转译器，安装前没有任何要跑的命令。`src/` 里读到的就是你实际加载的。

## 依赖

运行时依赖为零。Client 半边需要 `react`，由 Harness loader 提供；Host 半边什么都不需要。

## 目录结构

```
dsh-prompt-polish/
├── src/
│   ├── index.js            # Host 半边：HTTP 路由 + 润色流水线
│   └── client.js           # Client 半边：输入框里的按钮
├── docs/
│   └── IMPLEMENTATION.md   # 复刻说明书：契约、提示词原文、边界
├── locale/
│   ├── en.json             # 插件卡元数据（锚点语言）
│   └── zh.json             # 中文元数据
├── assets/
│   └── icon.svg            # 插件图标
├── scripts/
│   └── check.mjs           # 零依赖自检脚本
├── .github/
│   ├── workflows/ci.yml
│   └── ISSUE_TEMPLATE/
├── cordis.patch.yml        # bundle 补丁：一行 Host
├── package.json
├── README.md               # 英文说明
├── README.zh.md            # 本文件
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
├── .gitattributes
└── .gitignore
```

## 复刻说明书

[docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) 是「照着再实现一遍」的文档：行为契约、
**逐字的** system 与 user 提示词、四档风格指令、上下文块格式、保真闸正则、模型兜底链、
十五条边界、十四项自测。写给另一个工程师——或另一个模型——让它不必先读 `src/` 就能在别的宿主上复现。

只要提示词原文、不打算做完整插件的话，直接跳到该文档 §11。

## 自检

```sh
node scripts/check.mjs
```

解析全部随包发布的 JavaScript 与 JSON 文件，再交叉核对 `exports`、`files`、`dsh.bundle.patch` 是否指向真实存在的文件、Client 模块 id 是否等于包名、Host 半边是否仍导出 `inject` 与 `apply`。不需要 `npm install`。

## 它如何调用模型

1. `POST /dsh-prompt-polish/polish`，请求体 `{ text, style, sessionId?, provider?, model?, reasoningEffort? }`。
2. Host 选定路由（见上文「它做什么」），拼出系统提示、用户提示、风格指令与最近上下文块。
3. 一次 `ctx.llm.stream()` 调用，`temperature: 1`。只累加 `text-delta` 分片；`finish` 为 `kind: 'error' | 'aborted'` 时按失败上报。
4. 结果先清洗（剥掉一层围栏代码块或包裹引号），再过忠实度守卫。失败时附带明确纠正说明重试一次，说明里点名缺失的 token 和长度上限。
5. 返回 `{ ok: true, text, provider, model, style, fidelity, contextUsed }`，或 `{ ok: false, code, error }`，`code` 取值 `empty_input`、`no_model`、`llm_error`、`aborted`、`empty_result`、`invalid_request`、`not_found`、`method_not_allowed`、`internal`。

只读 `text-delta` 与 `finish`，所以流式返回推理块的上游不会带来额外开销。

## 隐私

- 草稿、最近上下文块和改写结果都会发往**你自己配置**的 `llm` 上游——那就是模型调用本身。
- 除此之外不发往任何地方。没有埋点，没有统计，没有本插件自己的远程端点。
- 唯一持久化的是所选风格，存在浏览器 `localStorage` 的 `dsh-prompt-polish.style` 下。
- 本插件不保存、不读取、不转发任何凭据。

## 兼容性

Client 半边面向 `@deepseek-ai/dsh-client-ui-conversation` 声明的插槽契约。若未来 Harness 挪动该插槽，按钮会不再出现，而不会弄坏输入框——注册包在 `ctx.effect` 里，卸载时干净释放。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。一句话：`node scripts/check.mjs` 必须通过，行为变更需要在 [CHANGELOG.md](CHANGELOG.md) 里补一句说明。

## 仓库地址

```sh
git clone https://github.com/CTX666666/dsh-prompt-polish.git
```

清单里的 `repository`、`homepage`、`bugs`、`author` 已经指向这个地址，克隆下来可以直接推：

```sh
git init -b main
git add -A
git commit -m "feat: Work Buddy style prompt-polish button for DSH"
git remote add origin git@github.com:CTX666666/dsh-prompt-polish.git
git push -u origin main
```

`package.json` 故意保留 `"private": true`：本插件的分发形式是一个由 DSH profile 安装的目录
（或 git URL），不是 npm 上的包。该标记只是防止误 `npm publish`，不影响 clone、fork 与安装。

## 许可

[MIT](LICENSE)
