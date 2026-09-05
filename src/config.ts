// src/config.ts
import { Schema } from 'koishi'

/**
 * 创建欢迎消息 Schema (table 展示)
 * 支持延迟发送配置
 */
const createWelcomeMessagesSchema = () => {
  return Schema.array(
    Schema.object({
      guildId: Schema.string().description('群组/频道 ID'),
      message: Schema.string().role('textarea').description('入群欢迎消息'),
      delaySeconds: Schema.natural()
        .min(0)
        .max(300)
        .default(0)
        .description('延迟发送时间（秒），0 表示立即发送'),
    })
  ).default([]).role('table')
}

/**
 * 创建离开消息 Schema (table 展示)
 * 支持延迟发送配置
 */
const createLeaveMessagesSchema = () => {
  return Schema.array(
    Schema.object({
      guildId: Schema.string().description('群组/频道 ID'),
      message: Schema.string().role('textarea').description('退群提醒消息'),
      delaySeconds: Schema.natural()
        .min(0)
        .max(300)
        .default(0)
        .description('延迟发送时间（秒），0 表示立即发送'),
    })
  ).default([]).role('table')
}

/**
 * 创建单个 Bot 配置 Schema
 */
const createBotConfigSchema = () => {
  return Schema.intersect([
    // Bot 选择
    Schema.object({
      platform: Schema.string()
        .description('**平台名称**<br>如 onebot / discord / telegram')
        .required(),
      botId: Schema.string()
        .description('**Bot 自身账号 ID**')
        .required(),
      delayMode: Schema.union([
        Schema.const('sliding' as const).description('滑动窗口 - 每个新事件重置定时器，最大化合并效果'),
        Schema.const('fixed' as const).description('固定窗口 - 第一个事件触发后不再重置，延迟时间可预测'),
      ])
        .description('延迟模式')
        .default('sliding'),
    }),

    // 入群消息配置
    Schema.object({
      welcomeMessages: createWelcomeMessagesSchema(),
    }),

    // 退群消息配置
    Schema.object({
      leaveMessages: createLeaveMessagesSchema(),
    }),
  ])
}

/**
 * 静态导出（用于配置界面）
 */
export const ConfigSchema = Schema.intersect([
  Schema.object({
    bots: Schema.array(createBotConfigSchema())
      .role('list')
      .default([])
      .description('**Bot 欢迎消息配置列表**\n\n添加 Bot 后，每个 Bot 将拥有独立的群组欢迎/退群消息配置'),
  }),
  Schema.object({
    debug: Schema.boolean()
      .description('是否输出调试日志')
      .default(false),
    verboseLogging: Schema.boolean()
      .description('显示详细日志（关闭后只输出关键信息）')
      .default(false),
  }).description('日志设置'),

  Schema.object({
    resource: Schema.object({
      allowLocalResources: Schema.boolean()
        .description('允许加载本地文件/图片资源（file:// 或本地路径）。出于安全考量默认关闭')
        .default(false),
    }).description('资源设置'),
  }),
])

export const name = 'multibot-groupwelcome'
