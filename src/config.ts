/**
 * dsh-im-qqbot 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';

export interface AccessControlConfig {
  /** C2C 访问模式 */
  c2cMode: 'open' | 'allowlist' | 'disabled';
  /** C2C 白名单（user openid） */
  c2cAllow: string[];
  /** 群聊访问模式 */
  groupMode: 'open' | 'allowlist' | 'disabled';
  /** 群聊白名单（group openid） */
  groupAllow: string[];
}

export interface MediaConfig {
  /** 是否启用富媒体理解（图片/视频下载 + 工具分析） */
  enabled: boolean;
  /** 富媒体下载大小上限（MB），默认 200 */
  maxMB: number;
  /** 富媒体存活时长（小时，TTL），默认 24，0 = 永不过期 */
  ttlHours: number;
}

export interface VisionConfig {
  /** 是否启用视觉理解（qqbot_describe_image 工具） */
  enabled: boolean;
  /** 视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai） */
  provider: string;
  /** 视觉模型 id（如 qwen-vl-max） */
  model: string;
  /** 默认描述 prompt（调用未显式指定时使用） */
  defaultPrompt: string;
  /** 图片字节上限，默认 10MB */
  maxBytes: number;
  /** 输出 token 上限 */
  maxTokens: number;
  /** 视觉调用超时(ms) */
  timeoutMs: number;
}

/** 附件发送配置（qqbot_send_file 工具与 present 交付物投递共用） */
export interface SendFileConfig {
  /** 是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots；关闭则任意路径） */
  restrictPaths: boolean;
  /** 额外允许访问的根目录（media 和 agent cwd 始终默认允许） */
  extraRoots: string[];
  /** 是否把 present 声明的交付文件在轮末发送到当前会话 */
  sendPresentedFiles: boolean;
  /** 单轮最多投递的交付文件数 */
  maxFiles: number;
}

/** 通知推送目标（fork 新增）：id 留空 = 未配置，走自动学习 */
export interface NotificationTargetConfig {
  /** 目标类型：c2c 私聊 / group 群聊 */
  kind: 'c2c' | 'group';
  /** 目标 openid（c2c 为用户 openid，group 为群 openid） */
  id: string;
}

/** 通知推送配置（fork 新增）：非 QQ 会话的完成/提问/审批 → QQ */
export interface NotificationsConfig {
  /** 通知推送总开关 */
  enabled: boolean;
  /** 固定推送目标；id 留空时自动学习私聊目标 / 最近会话 */
  target: NotificationTargetConfig;
  /** 是否从私聊消息学习推送目标并持久化（只学 c2c，群聊不参与） */
  learnFromChats: boolean;
  /** 任务完成推送 */
  onDone: {
    enabled: boolean;
    /** 预览截断字符数，0 = 推送完整最终文本 */
    previewChars: number;
    /** 推送页眉，空串 = 不加页眉 */
    header: string;
  };
  /** 提问推送（ask_user_question） */
  onQuestion: {
    enabled: boolean;
    /** 问题文本截断字符数，0 = 不截断 */
    questionChars: number;
    /** 选项文本截断字符数，0 = 不截断 */
    optionChars: number;
  };
  /** 审批推送（approval/request） */
  onApproval: {
    enabled: boolean;
    /** 被 gate 命令回显截断字符数，0 = 不截断 */
    commandChars: number;
  };
  /** 同类完成推送的最小间隔(ms)，0 = 不限制 */
  cooldownMs: number;
}

export interface ImQQBotConfig {
  /** QQ Bot AppID */
  appId: string;
  /** QQ Bot AppSecret */
  appSecret: string;
  /** dsh LLM 提供商名称 */
  provider?: string;
  /** 模型名称 */
  model?: string;
  /** Agent preset id */
  preset?: string;
  /** Agent 工作目录（缺省回落到进程 cwd） */
  cwd?: string;
  /** 是否启用群消息 @mention 门控 */
  requireMention: boolean;
  /** 群聊额外 system prompt */
  groupPrompt?: string;
  /** 私聊额外 system prompt */
  directPrompt?: string;
  /** 单条消息最大长度（QQ 限制约 5000 字符） */
  textChunkLimit: number;
  /** 是否启用流式输出（群聊始终不启用） */
  streaming: boolean;
  /** 每会话最大闲置时长(ms)，超时自动回收 */
  sessionIdleTimeout: number;
  /** 并发队列最大长度 */
  maxQueue: number;
  /** 处理超时(ms)，超时中断当前 LLM 调用 */
  processingTimeoutMs: number;
  /** 待答问题超时(ms)，超时自动拒绝并提示（ask_user_question） */
  askTimeoutMs: number;
  /** 群历史缓冲条数 */
  historyLimit: number;
  /** 访问控制 */
  access: AccessControlConfig;
  /** 是否展示工具调用成功结果（工具错误始终展示） */
  showToolResults: boolean;
  /** 调试模式 */
  debug: boolean;
  /** 富媒体理解（图片/视频） */
  media: MediaConfig;
  /** 视觉理解（qqbot_describe_image 工具，走 dsh llm + attachments） */
  vision: VisionConfig;
  /** 附件发送（qqbot_send_file 工具与交付物投递共用） */
  sendFile: SendFileConfig;
  /** 通知推送（非 QQ 会话的完成 / 提问 / 审批 → QQ；fork 新增） */
  notifications: NotificationsConfig;
}

/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema: Schema<AccessControlConfig> = Schema.object({
  c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('C2C访问模式'),
  c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单'),
  groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('群聊访问模式'),
  groupAllow: Schema.array(Schema.string()).default([]).description('群聊白名单'),
});

/** 通知推送目标 Schema（fork 新增；id 留空 = 未配置，走自动学习） */
const NotificationTargetSchema = Schema.object({
  kind: Schema.union(['c2c', 'group']).default('c2c').description('推送目标类型'),
  id: Schema.string().default('').description('目标 openid（留空 = 未配置，自动学习）'),
});

/** 通知推送 Schema（fork 新增） */
export const NotificationsSchema: Schema<NotificationsConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('通知推送总开关'),
  target: NotificationTargetSchema.default({ kind: 'c2c', id: '' }).description('固定推送目标'),
  learnFromChats: Schema.boolean().default(true).description('从私聊消息学习推送目标并持久化'),
  onDone: Schema.object({
    enabled: Schema.boolean().default(true).description('任务完成推送'),
    previewChars: Schema.number().default(0).description('预览截断字符数，0 = 推送完整最终文本'),
    header: Schema.string().default('## ✅ DSH 任务完成').description('推送页眉，空串 = 不加页眉'),
  }).default({
    enabled: true,
    previewChars: 0,
    header: '## ✅ DSH 任务完成',
  }).description('任务完成推送配置'),
  onQuestion: Schema.object({
    enabled: Schema.boolean().default(true).description('提问推送（ask_user_question）'),
    questionChars: Schema.number().default(120).description('问题文本截断字符数，0 = 不截断'),
    optionChars: Schema.number().default(60).description('选项文本截断字符数，0 = 不截断'),
  }).default({
    enabled: true,
    questionChars: 120,
    optionChars: 60,
  }).description('提问推送配置'),
  onApproval: Schema.object({
    enabled: Schema.boolean().default(true).description('审批推送（approval/request）'),
    commandChars: Schema.number().default(500).description('命令回显截断字符数，0 = 不截断'),
  }).default({
    enabled: true,
    commandChars: 500,
  }).description('审批推送配置'),
  cooldownMs: Schema.number().default(0).description('同类完成推送最小间隔(ms)，0 = 不限制'),
});

export const ConfigSchema: Schema<ImQQBotConfig> = Schema.object({
  appId: Schema.string().default('').description('QQ 机器人 AppID'),
  appSecret: Schema.string().default('').description('QQ 机器人 AppSecret'),
  provider: Schema.string().description('LLM provider name'),
  model: Schema.string().description('Model name'),
  preset: Schema.string().description('Agent preset id'),
  cwd: Schema.string().description('Agent working directory'),
  requireMention: Schema.boolean().default(true).description('群聊是否需要@bot触发'),
  groupPrompt: Schema.string().description('群聊额外system prompt'),
  directPrompt: Schema.string().description('私聊额外system prompt'),
  textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
  streaming: Schema.boolean().default(true).description('是否启用流式输出（群聊始终不启用）'),
  sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置超时(ms)'),
  maxQueue: Schema.number().default(20).description('并发队列最大长度'),
  processingTimeoutMs: Schema.number().default(30 * 60 * 1000).description('处理超时(ms)，超时中断当前 LLM 调用'),
  askTimeoutMs: Schema.number().default(5 * 60 * 1000).description('待答问题超时(ms)，超时自动拒绝并提示'),
  historyLimit: Schema.number().default(10).description('群历史缓冲条数'),
  access: AccessControlSchema.default({
    c2cMode: 'open',
    c2cAllow: [],
    groupMode: 'open',
    groupAllow: [],
  }).description('访问控制'),
  showToolResults: Schema.boolean().default(false).description('是否展示工具调用成功结果（错误始终展示）'),
  debug: Schema.boolean().default(false),
  media: Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用富媒体理解（图片/视频下载 + 工具分析）'),
    maxMB: Schema.number().default(200).description('富媒体下载大小上限(MB)'),
    ttlHours: Schema.number().default(24).description('富媒体存活时长(小时)，0=永不过期'),
  }).default({
    enabled: true,
    maxMB: 200,
    ttlHours: 24,
  }).description('富媒体理解配置'),
  vision: Schema.object({
    enabled: Schema.boolean().default(false).description('是否启用视觉理解（qqbot_describe_image 工具）'),
    provider: Schema.string().default('').description('视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai）'),
    model: Schema.string().default('').description('视觉模型 id（如 qwen-vl-max）'),
    defaultPrompt: Schema.string().default('Describe this image in detail.').description('默认描述 prompt'),
    maxBytes: Schema.number().default(10 * 1024 * 1024).description('图片字节上限'),
    maxTokens: Schema.number().default(1024).description('输出 token 上限'),
    timeoutMs: Schema.number().default(120000).description('视觉调用超时(ms)'),
  }).default({
    enabled: false,
    provider: '',
    model: '',
    defaultPrompt: 'Describe this image in detail.',
    maxBytes: 10 * 1024 * 1024,
    maxTokens: 1024,
    timeoutMs: 120000,
  }).description('视觉理解配置'),
  sendFile: Schema.object({
    restrictPaths: Schema.boolean().default(true).description('是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots）'),
    extraRoots: Schema.array(Schema.string()).default([]).description('额外允许访问的根目录'),
    sendPresentedFiles: Schema.boolean().default(true).description('是否将 present 声明的交付文件发送到当前会话'),
    maxFiles: Schema.number().default(4).description('单轮最多投递的交付文件数'),
  }).default({
    restrictPaths: true,
    extraRoots: [],
    sendPresentedFiles: true,
    maxFiles: 4,
  }).description('附件发送配置'),
  notifications: NotificationsSchema.default({
    enabled: true,
    target: { kind: 'c2c', id: '' },
    learnFromChats: true,
    onDone: { enabled: true, previewChars: 0, header: '## ✅ DSH 任务完成' },
    onQuestion: { enabled: true, questionChars: 120, optionChars: 60 },
    onApproval: { enabled: true, commandChars: 500 },
    cooldownMs: 0,
  }).description('通知推送配置（非 QQ 会话的完成 / 提问 / 审批 → QQ；fork 新增）'),
});
