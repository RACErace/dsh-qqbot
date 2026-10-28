<div align="center">

<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

**基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 的 QQ Bot 插件，将 DeepSeek AI 助手接入 QQ 私聊与群聊。**

[![npm version](https://img.shields.io/npm/v/@tencent-connect/dsh-qqbot)](https://www.npmjs.com/package/@tencent-connect/dsh-qqbot)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/tencent-connect/dsh-qqbot)](https://github.com/tencent-connect/dsh-qqbot)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)

<br/>

**[English](./README_EN.md) | 简体中文**

扫码加入 QQ 群 / 频道

<table>
<tr>
<td align="center" width="50%"><img src="./assets/docs/qqgroup.jpg" height="360" alt="QQ 群二维码" /><br /><b>QQ 开发者交流群</b><br /><sub>群号: 1032635674</sub></td>
<td align="center" width="50%"><img src="./assets/docs/qqchannel.jpg" height="360" alt="QQ 频道二维码" /><br /><b>QQ 开发者社区频道</b><br /><sub>频道号: 20dnumts4z</sub></td>
</tr>
</table>

</div>

> **本仓库是 fork**：基于上游 [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)（npm `@tencent-connect/dsh-qqbot`），在原插件之上新增 **QQ 通知推送**（非 QQ 会话的任务完成 / 提问 / 审批 → QQ，并提供对外 notify 服务）。其余功能与上游一致；同步上游用 `git fetch upstream && git merge upstream/main`。

## 架构

```
QQ 用户 → QQ WebSocket → dsh-qqbot → ctx.agents → dsh agent loop → LLM
                                 ↑                           │
                                 └── session/event ──────────┘
                                       (assistant reply → QQ sendMarkdown)

桌面 / CLI / Web 会话 ── turn/end · ask_user_question · approval/request ──→ 通知桥 → QQ
```

## 安装

### 方式一：桌面版安装（推荐）

无需命令行，全程在应用内完成：

1. **安装**：左侧栏点击「插件」→「添加插件」→ 输入 `@tencent-connect/dsh-qqbot@latest` → 安装并立即启动

<img src="./assets/docs/install.png" alt="端内添加插件" width="560" />

2. **连接**：左下角头像 → 设置 →「QQ 机器人」→ 手机 QQ 扫码连接

<img src="./assets/docs/setting.png" alt="设置页扫码连接" width="560" />

扫码成功后凭据自动保存，后续启动无需再次扫码。

### 方式二：手动执行

```bash
# 安装到 profile
npx @deepseek-ai/dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot

# 启动
npx @deepseek-ai/dsh --profile qqbot
```

首次启动时，插件检测到凭据未配置会自动进入扫码引导：终端输出二维码 → 手机 QQ 扫码绑定 → 凭据自动保存到 profile，后续启动无需再次扫码。

无端内绑定页的环境（如纯 CLI）可设置 `QQBOT_BIND_OPEN_BROWSER=1`，额外拉起系统浏览器扫码页作为降级通道。

<img src="./assets/docs/qrcode.png" alt="二维码扫码示意图" width="280" />

> **提示**：建议升级至 `0.4.0` 以上版本扫码，支持点击链接在浏览器打开，避免部分终端二维码渲染错位的问题。

### 方式三：本地路径安装

```bash
# 构建
cd /path/to/dsh-qqbot
pnpm install && pnpm build

# 安装到 profile（本地路径）
npx @deepseek-ai/dsh plugin --profile qqbot add /path/to/dsh-qqbot

# 启动
export QQBOT_APPID="你的AppID" QQBOT_SECRET="你的AppSecret"
npx @deepseek-ai/dsh --profile qqbot
```

### 方式四：--patch 开发模式

```bash
export QQBOT_APPID="你的AppID" QQBOT_SECRET="你的AppSecret"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot/cordis.dev.yml
```

## 配置项

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `appId` | string | **必填** | QQ Bot AppID（或通过 `QQBOT_APPID` 环境变量） |
| `appSecret` | string | **必填** | QQ Bot AppSecret（或通过 `QQBOT_SECRET` 环境变量） |
| `provider` | string | `deepseek-official` | LLM 提供商名称 |
| `model` | string | `deepseek-chat` | 模型名称 |
| `preset` | string | - | Agent preset id |
| `cwd` | string | `process.cwd()` | Agent 工作目录 |
| `requireMention` | boolean | `true` | 群聊是否需要 @bot 才触发 |
| `groupPrompt` | string | - | 群聊额外 system prompt |
| `directPrompt` | string | - | 私聊额外 system prompt |
| `textChunkLimit` | number | `4500` | 单条消息最大字符数 |
| `streaming` | boolean | `true` | 是否启用流式输出（群聊始终不启用） |
| `sessionIdleTimeout` | number | `1800000` | 会话闲置超时(ms)，默认 30 分钟 |
| `processingTimeoutMs` | number | `1800000` | 处理超时(ms)，超时中断当前 LLM 调用 |
| `maxQueue` | number | `20` | 并发队列最大长度 |
| `historyLimit` | number | `10` | 群历史缓冲条数 |
| `askTimeoutMs` | number | `300000` | 待答问题超时(ms)，默认 5 分钟（ask_user_question） |
| `showToolResults` | boolean | `false` | 是否展示工具调用成功结果（错误始终展示） |
| `debug` | boolean | `false` | 调试模式 |

### 访问控制（access）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `access.c2cMode` | `open`/`allowlist`/`disabled` | `open` | 私聊访问模式 |
| `access.c2cAllow` | string[] | `[]` | 私聊白名单（user openid） |
| `access.groupMode` | `open`/`allowlist`/`disabled` | `open` | 群聊访问模式 |
| `access.groupAllow` | string[] | `[]` | 群聊白名单（group openid） |

### 富媒体理解（media）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `media.enabled` | boolean | `true` | 是否启用富媒体理解（图片/视频下载 + 工具分析） |
| `media.maxMB` | number | `200` | 富媒体下载大小上限(MB) |
| `media.ttlHours` | number | `24` | 富媒体存活时长(小时)，0=永不过期 |

### 视觉理解（vision）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `vision.enabled` | boolean | `false` | 是否启用视觉理解（qqbot_describe_image 工具） |
| `vision.provider` | string | - | 视觉模型 provider（如 pi-ai） |
| `vision.model` | string | - | 视觉模型 id（如 qwen-vl-max） |
| `vision.maxBytes` | number | `10MB` | 图片字节上限 |
| `vision.maxTokens` | number | `1024` | 输出 token 上限 |
| `vision.timeoutMs` | number | `120000` | 视觉调用超时(ms) |

### 附件发送（sendFile）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `sendFile.restrictPaths` | boolean | `true` | 是否启用路径白名单（仅 media + cwd + extraRoots） |
| `sendFile.extraRoots` | string[] | `[]` | 额外允许访问的根目录 |

### 通知推送（notifications，fork 新增）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `notifications.enabled` | boolean | `true` | 通知推送总开关 |
| `notifications.target.kind` | `c2c`/`group` | `c2c` | 固定推送目标类型 |
| `notifications.target.id` | string | `''` | 固定推送目标 openid；留空 = 自动学习首个私聊对象 |
| `notifications.learnFromChats` | boolean | `true` | 是否从私聊消息学习推送目标并落盘（群聊不参与） |
| `notifications.onDone.enabled` | boolean | `true` | 任务完成推送 |
| `notifications.onDone.previewChars` | number | `0` | 预览截断字符数，0 = 推送完整最终文本 |
| `notifications.onDone.header` | string | `## ✅ DSH 任务完成` | 推送页眉，空串 = 不加页眉 |
| `notifications.onQuestion.enabled` | boolean | `true` | 提问推送（ask_user_question） |
| `notifications.onQuestion.questionChars` | number | `120` | 问题文本截断字符数，0 = 不截断 |
| `notifications.onQuestion.optionChars` | number | `60` | 选项文本截断字符数，0 = 不截断 |
| `notifications.onApproval.enabled` | boolean | `true` | 审批推送（approval/request） |
| `notifications.onApproval.commandChars` | number | `500` | 被 gate 命令回显截断字符数，0 = 不截断 |
| `notifications.cooldownMs` | number | `0` | 同类完成推送最小间隔(ms)，0 = 不限制 |

## 内置命令

| 命令 | 说明 |
|------|------|
| `/new`（别名 `/reset` `/clear`） | 开始新会话（清空上下文） |
| `/compact` | 压缩会话历史（摘要替换旧记录，保留上下文） |
| `/model` | 查看或切换模型 |
| `/preset` | 查看或切换 agent preset（新会话生效） |
| `/stop` | 中止当前生成 |
| `/bot-ping` | 网络延迟检测（返回传输与处理耗时） |
| `/bot-version` | 查看版本信息 |
| `/bot-status` | 查看当前会话状态 |
| `/bot-help` | 查看所有指令 |

## 通知推送（fork 新增）

上游把 QQ 会话当聊天前端；本 fork 额外补了另一个方向：**在桌面 / CLI / Web 里发起的工作，也能通过 QQ 收结果、答问题、批操作**。QQ 会话自己的轮次不会重复推送。

### 推送目标

按优先级解析：`notifications.target`（`id` 非空）→ 学习到的私聊目标 → 最近一次 QQ 会话（仅提问/审批兜底）。
`learnFromChats` 打开时，用户第一次私聊机器人即被记为通知目标，并持久化到
`<DSH home>/storages/im-qqbot/notification-target.json`，重启后继续生效。

### 三类推送

| 事件 | 推送内容 | 在 QQ 的回复方式 |
|------|----------|------------------|
| 任务完成（`turn/end` completed） | `onDone.header` + 最终回复文本（`previewChars>0` 时截断为单行预览） | 无需回复 |
| 提问（`ask_user_question`） | 问题卡片 + 选项 + 作答引导（单选带内联按钮） | 选项编号 `1` / 字母 `A`；多选 `1,3`；或直接输入自定义文字 |
| 审批（`approval/request`） | 工具名 + 命令回显 + 原因（带「允许/拒绝」按钮） | 「允许」/「拒绝」（也可回 `1`/`2` 或点按钮） |

提问与审批都会**与宿主 Web/CLI 的回答者竞速**（先答先赢）；宿主侧没有可用通道时不会报错，继续等 QQ 回复。
每个会话同一时间只保留一个待答问题 / 待批审批；会话被回收或插件停用时自动取消。
QQ 先答时，会通过宿主 `typertGateway` 的待投递事件表取消 Web/桌面侧已弹出的问题卡片与审批提示（与本地 dsh-qqbot 插件的 cancelWeb 行为一致；宿主 pending 登记较晚时按固定节奏重试，私有 API 不可用时静默降级——卡片保留但不影响结果）。
QQ 会话自身的提问/审批仍走原来的按钮通道，通知桥只处理非 QQ 会话。

### 对外通知服务

插件在 ctx 上提供 `im-qqbot` 服务（服务名与插件 id 一致），兄弟插件可解耦推送：

```ts
const notify = ctx.get('im-qqbot') as
  | {
      notify(text: string): Promise<void>
      sendMessage(
        target: { kind: 'c2c' | 'group'; id: string },
        text: string,
        images?: string[],
      ): Promise<number>
    }
  | undefined

await notify?.notify('构建完成 🎉')
```

`notify(text)` 推到通知目标；`sendMessage(target, text, images?)` 推到显式目标（`images` 为本地图片绝对路径）。

### 配置示例

```yaml
- id: im-qqbot
  config:
    notifications:
      target: { kind: c2c, id: '<user openid>' }   # 留空则自动学习
      onDone: { previewChars: 200, header: '## ✅ DSH 任务完成' }
      onQuestion: { enabled: true }
      onApproval: { enabled: true }
      cooldownMs: 3000
```

## 核心模块

```
src/
├── index.ts                    # Cordis 插件入口（async apply）
├── config.ts                   # 配置 Schema
├── types.ts                    # 全局类型定义
├── setup/                      # 凭据绑定（扫码）
│   ├── index.ts                # 绑定编排（ensureCredentials）
│   ├── binding-service.ts      # 扫码状态机（宿主内唯一事实源）
│   ├── bind-routes.ts          # 端内绑定页路由（/qqbot/im-qqbot/bind）
│   ├── presenters.ts           # 呈现策略（终端/浏览器降级）
│   ├── qr-svg.ts               # 二维码 SVG 渲染（宿主侧）
│   └── persist.ts              # 凭据写入 cordis.patch.yml
├── client/                     # 浏览器半边（dsh.client Web Bundle）
│   ├── index.ts                # 侧栏 Tab 注册 + 待绑定自动引导
│   └── bind-page.ts             # 端内绑定页（二维码 + 状态轮询）
├── gateway/                    # 网关装配
│   ├── bootstrap.ts            # 启动装配（监听 session/event 等）
│   └── middleware-setup.ts     # 中间件链配置
├── transport/                  # 传输层
│   ├── inbound.ts              # QQ 入站消息 → agent.followup()
│   ├── outbound.ts             # session/event → QQ sendMarkdown
│   ├── outbound-buffer.ts      # 流式缓冲
│   ├── streaming-writer.ts     # 流式写入
│   ├── reply-target.ts         # 回复目标解析
│   ├── msgid-cache.ts          # 被动回复 msgid 缓存
│   ├── reply-limiter.ts        # 被动回复限流
│   ├── tool-presenter.ts       # 工具调用展示
│   └── chunker.ts              # Markdown 文本切分
├── session/                    # 会话管理层
│   ├── session-manager.ts      # QQ peer → Agent 映射
│   └── idle-evictor.ts         # 闲置回收
├── model/                      # 模型路由层
│   ├── model-resolver.ts       # 路由解析
│   ├── prefs-store.ts          # per-peer 偏好持久化
│   └── settings-reader.ts      # settings.yaml 只读
├── features/                   # 交互特性
│   ├── question-channel.ts     # ask_user_question 问答通道
│   ├── approval-channel.ts     # approval 审批确认通道
│   └── answer-parser.ts        # 答案解析
├── media/                      # 多媒体
│   ├── vision-tool.ts          # 图片视觉理解
│   ├── send-file-tool.ts       # 发送本地文件
│   └── media-cleaner.ts        # 媒体 TTL 清理
├── notification/               # 通知推送（fork 新增）
│   ├── target-store.ts         # 推送目标学习 / 持久化 / 恢复
│   ├── notification-channel.ts # 完成/提问/审批推送与 QQ 作答
│   ├── service.ts              # 对外 ctx.get('im-qqbot') 通知服务
│   └── format.ts               # 推送渲染与回复解析
├── middleware/                 # 中间件
│   ├── question-answer.ts      # 问答答案处理
│   ├── notification-answer.ts  # 通知提问/审批答复截获（fork 新增）
│   └── attachment.ts           # 附件处理
├── shared/                     # 共享工具
│   ├── utils.ts                # 通用函数
│   ├── scope.ts                # scope/peer 提取
│   └── send-helper.ts          # 分块发送
└── commands/                   # 斜杠命令
```

## 会话路由

sessionKey: `qqbot:${appId}:${scope}:${peerId}`，由 SHA-256 确定性派生 SessionId，重启后可恢复。

解析策略：进程内复用 → 持久化恢复 → 全新创建。

## 设计原则

- **纯 Cordis 插件** — 遵循 dsh "Plugins, not loop changes" 原则
- **声明式依赖** — `inject = ['agents']`，不直接耦合其他插件
- **会话隔离** — 每个 QQ 私聊用户/群聊各一个独立 Agent
- **Preset 支持** — 可通过 `agent-presets` 服务挂载预设（工具集、prompt 等）
- **闲置回收** — 超时自动 dispose Agent，防止内存泄漏
- **Markdown 输出** — 回复以 Markdown 格式发送，支持代码块/表格感知切分
- **图片理解** — 支持 `qqbot_describe_image` 视觉理解，可分析用户发送的图片
- **附件发送** — 支持 `qqbot_send_file` 将本地文件发送给用户（默认启用路径白名单）
- **问答互动** — 支持 `ask_user_question`，单选生成内联按钮（点一个其余变灰）、多选回复编号，逐题推进 + 问题级超时
- **操作确认** — 支持 `approval/request`，关键操作通过「允许/拒绝」按钮请求用户确认
- **通知桥（fork 新增）** — 非 QQ 会话的任务完成 / 提问 / 审批推送到 QQ，回复即作答；推送目标自动学习并持久化
- **对外通知服务（fork 新增）** — 其他插件通过 `ctx.get('im-qqbot')` 解耦推送，无需耦合 QQ 通道代码

## 本地开发

```bash
# 安装依赖
pnpm install

# 构建
pnpm build

# 开发模式（watch）
pnpm dev

# 用 --patch 方式调试
export QQBOT_APPID="xxx" QQBOT_SECRET="xxx"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot/cordis.dev.yml
```

## License

[MIT](./LICENSE)
