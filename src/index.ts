// src/index.ts
import { Context } from 'koishi'
import type { Config, BotConfig, WelcomeEventData, LeaveEventData } from './types'
import { formatMessage, formatBatchMessage } from './messages'

export { name, ConfigSchema as Config } from './config'
export * from './types'

export const usage = `
## 群组欢迎/退群消息插件

为多个 Bot 管理群组欢迎和退群消息。所有 Bot 共用同一插件实例，各自独立配置，无需其他插件支持。

### 配置方法

1. 添加 Bot 并填写（均可在**控制台 - 机器人列表**中查看）：
   - **平台名称**：如 onebot / discord / telegram
   - **Bot 自身账号 ID**：即 selfId，机器人列表中显示的账号号
2. 选择**延迟模式**：
   - **滑动窗口**：每个新事件重置定时器，最大化合并效果（默认）
   - **固定窗口**：第一个事件触发后不再重置，延迟时间可预测
3. 为每个 Bot 配置入群欢迎消息和退群消息：
   - **群组/频道 ID**：目标群组 ID
   - **入群欢迎消息**：支持变量 {user} {id} {at} {avatar} {group} {group_id} {group_count} {time} {hitokoto} {br} {imageURL="..."}
   - **延迟发送时间**：0 表示立即发送，大于 0 表示等待该秒数后合并多条消息一起发送
   - **退群提醒消息**：同上

### 消息变量

- {user} - 用户昵称
- {id} - 用户 ID
- {at} - @该用户
- {avatar} - 用户头像
- {group} - 群组名称
- {group_id} - 群组 ID
- {group_count} - 群组人数
- {time} - 当前时间
- {hitokoto} - 一言
- {br} - 换行
- {imageURL="..."} - 插入图片，支持本地路径、file:// URL、http(s) URL（本地资源需在配置中启用）

**退群消息特殊说明**：由于 OneBot 协议限制，退群事件不包含用户昵称。若消息中同时包含 \`{user}\` 和 \`{id}\`，插件会自动忽略 \`{user}\` 变量（避免显示为用户ID）。建议退群消息只使用 \`{id}\`。

### 延迟合并发送

设置延迟时间后，短时间内的多条入群/退群事件会合并为一条消息发送：
- 用户名、ID、@、头像会全部列出
- 群人数取最新值
- 时间取最后事件的时间

**延迟模式对比（延迟 5 秒）：**
- 滑动窗口：0s、2s、4s 各有一人加入 → 9s 发送合并消息（每次重置定时器）
- 固定窗口：0s、2s、4s 各有一人加入 → 5s 发送合并消息（第一次触发后不重置）
`

// 延迟发送管理器 - 按 platform:botId:guildId 复合 key 管理待发送的事件
interface DelayManager {
  // key: platform:botId:guildId, value: { events: WelcomeEventData[]; timer: NodeJS.Timeout; groupConfig: WelcomeMessageConfig; botKey: string }
  welcome: Map<string, {
    events: WelcomeEventData[]
    timer: NodeJS.Timeout
    groupConfig: any
    botKey: string
    session: any
  }>
  // key: platform:botId:guildId, value: { events: LeaveEventData[]; timer: NodeJS.Timeout; groupConfig: LeaveMessageConfig; botKey: string }
  leave: Map<string, {
    events: LeaveEventData[]
    timer: NodeJS.Timeout
    groupConfig: any
    botKey: string
    session: any
  }>
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('multibot-groupwelcome')

  // 创建延迟管理器
  const delayManager: DelayManager = {
    welcome: new Map(),
    leave: new Map(),
  }

  // 日志辅助函数
  const debugLog = (...args: unknown[]) => {
    if (config.debug) {
      logger.debug(args.join(' '))
    }
  }

  const verboseLog = (...args: unknown[]) => {
    if (config.verboseLogging) {
      logger.info(args.join(' '))
    }
  }

  logger.info(`Plugin loaded, ${(config.bots || []).length} bots configured`)
  debugLog('Debug logging enabled')
  verboseLog('Verbose logging enabled')

  // 输出当前配置状态（在插件加载时）
  verboseLog('=== Current Bot Configurations ===')
  for (const bot of config.bots) {
    const welcomeGuilds = bot.welcomeMessages.map(m => m.guildId).join(', ')
    const leaveGuilds = bot.leaveMessages.map(m => m.guildId).join(', ')
    verboseLog(`Bot: ${bot.platform}:${bot.botId}`)
    verboseLog(`  Welcome guilds: [${welcomeGuilds || 'none'}]`)
    verboseLog(`  Leave guilds: [${leaveGuilds || 'none'}]`)
  }
  verboseLog('====================================')

  /** 生成日志与延迟队列使用的 bot 复合 key */
  const getBotKey = (platform: string, selfId: string): string => {
    return `${platform}:${selfId}`
  }

  /** 按平台 + Bot 自身 ID 匹配用户配置 */
  const getBotConfig = (platform: string, selfId: string): BotConfig | undefined => {
    return config.bots.find(bot => bot.platform === platform && bot.botId === selfId)
  }

  /** 列出当前在线 Bot（platform:selfId），帮助用户核对要填写的配置值 */
  const listOnlineBots = (): string => {
    const bots = ctx.bots
      .filter(bot => bot.platform && bot.selfId)
      .map(bot => `${bot.platform}:${bot.selfId}`)
      .sort()
    return bots.join(', ') || '无'
  }

  /**
   * 检查 bot 配置是否有效（有任何消息配置）
   */
  const isBotConfigValid = (botConfig: BotConfig): boolean => {
    const hasWelcome = botConfig.welcomeMessages && botConfig.welcomeMessages.length > 0
    const hasLeave = botConfig.leaveMessages && botConfig.leaveMessages.length > 0
    return hasWelcome || hasLeave
  }

  /**
   * 获取用户名
   */
  const getUserName = async (session: any): Promise<string> => {
    const userId = session.userId
    // 尝试从多个来源获取用户名
    const name = session.username ||
                 session.author?.nick ||
                 session.author?.name ||
                 session.event?.member?.nick ||
                 session.event?.member?.name ||
                 session.event?.user?.nick ||
                 session.event?.user?.name ||
                 userId

    // 如果只获取到 userId，尝试获取群成员详情
    if (name === userId) {
      try {
        const member = await session.bot.getGuildMember(session.guildId, userId)
        // 优先使用群名片，其次是用户昵称（member.user?.name）
        return member?.nick || member?.user?.name || userId
      } catch {
        return userId
      }
    }
    return name
  }

  const sendMessage = async (session: any, message: any) => {
    if (session.channelId) {
      await session.send(message)
    } else {
      await session.bot.sendMessage(session.guildId, message)
    }
  }

  /**
   * 生成延迟管理器的复合 key，确保每个 bot 的队列独立
   */
  const getDelayKey = (botKey: string, guildId: string): string => {
    return `${botKey}:${guildId}`
  }

  /**
   * 处理延迟的欢迎消息发送
   */
  const processDelayedWelcome = async (botKey: string, guildId: string) => {
    const key = getDelayKey(botKey, guildId)
    const pending = delayManager.welcome.get(key)
    if (!pending) return

    // 清除定时器并从 Map 中移除
    clearTimeout(pending.timer)
    delayManager.welcome.delete(key)

    const { events, groupConfig, session } = pending

    if (events.length === 0) return

    try {
      let message: any

      if (events.length === 1) {
        // 只有一个事件，使用单条消息格式化
        verboseLog(`[${botKey}] Sending single welcome message for guild ${guildId}`)
        message = await formatMessage(ctx, session, groupConfig.message, config.resource)
      } else {
        // 多个事件，使用批量消息格式化
        verboseLog(`[${botKey}] Sending batch welcome message for guild ${guildId}, ${events.length} users`)
        message = await formatBatchMessage(ctx, session, groupConfig.message, events, false, config.resource)
      }

      await sendMessage(session, message)
      logger.info(`[${botKey}] Welcome message sent for guild ${guildId} (${events.length} user${events.length > 1 ? 's' : ''})`)
      verboseLog(`[${botKey}] Message template: ${groupConfig.message}`)
    } catch (error) {
      logger.error(`[${botKey}] Failed to send welcome message:`, error)
    }
  }

  /**
   * 处理延迟的离开消息发送
   */
  const processDelayedLeave = async (botKey: string, guildId: string) => {
    const key = getDelayKey(botKey, guildId)
    const pending = delayManager.leave.get(key)
    if (!pending) return

    // 清除定时器并从 Map 中移除
    clearTimeout(pending.timer)
    delayManager.leave.delete(key)

    const { events, groupConfig, session } = pending

    if (events.length === 0) return

    try {
      let message: any

      if (events.length === 1) {
        // 只有一个事件，使用单条消息格式化
        verboseLog(`[${botKey}] Sending single leave message for guild ${guildId}`)
        message = await formatMessage(ctx, session, groupConfig.message, config.resource)
      } else {
        // 多个事件，使用批量消息格式化
        verboseLog(`[${botKey}] Sending batch leave message for guild ${guildId}, ${events.length} users`)
        message = await formatBatchMessage(ctx, session, groupConfig.message, events, true, config.resource)
      }

      await sendMessage(session, message)
      logger.info(`[${botKey}] Leave message sent for guild ${guildId} (${events.length} user${events.length > 1 ? 's' : ''})`)
      verboseLog(`[${botKey}] Message template: ${groupConfig.message}`)
    } catch (error) {
      logger.error(`[${botKey}] Failed to send leave message:`, error)
    }
  }

  // bot 上下线时提示当前在线列表，方便用户核对配置中填写的平台与 Bot ID
  ctx.on('bot-added', () => verboseLog(`当前在线 Bot: ${listOnlineBots()}`))
  ctx.on('bot-removed', () => verboseLog(`当前在线 Bot: ${listOnlineBots()}`))

  ctx.on('guild-member-added', async (session) => {
    // 在事件入口就记录详细信息
    verboseLog(`[EVENT] guild-member-added - selfId: ${session.selfId}, platform: ${session.platform}, guild: ${session.guildId}, user: ${session.userId}`)

    const guildId = session.guildId
    const userId = session.userId

    if (!guildId || !userId) {
      verboseLog(`[EVENT] guild-member-added missing guildId or userId`)
      return
    }

    const botKey = getBotKey(session.platform || '', session.selfId || '')
    const botConfig = getBotConfig(session.platform || '', session.selfId || '')

    debugLog(`[${botKey}] Processing guild-member-added event`)

    // 检查配置是否存在
    if (!botConfig) {
      verboseLog(`[${botKey}] No config found for this bot in plugin`)
      debugLog(`[${botKey}] 若要为该 Bot 配置消息，请将「平台名称」填写为 "${session.platform}"，「Bot 自身账号 ID」填写为 "${session.selfId}"`)
      return
    }

    // 检查配置有效性
    if (!isBotConfigValid(botConfig)) {
      verboseLog(`[${botKey}] Config exists but no messages configured`)
      return
    }

    // 检查群组配置
    const groupConfig = botConfig.welcomeMessages.find(m => m.guildId === guildId)
    if (!groupConfig) {
      verboseLog(`[${botKey}] No welcome config for guild ${guildId}`)
      return
    }

    if (!groupConfig.message) {
      verboseLog(`[${botKey}] Welcome config exists for guild ${guildId} but message is empty`)
      return
    }

    // 收集事件数据
    const eventData: WelcomeEventData = {
      userId,
      userName: await getUserName(session),
      timestamp: Date.now(),
    }

    // 检查是否启用延迟发送
    if (groupConfig.delaySeconds > 0) {
      verboseLog(`[${botKey}] Delay enabled for guild ${guildId}, waiting ${groupConfig.delaySeconds}s`)

      // 使用复合 key 确保每个 bot 的队列独立
      const key = getDelayKey(botKey, guildId)

      // 检查是否已有待发送的队列
      const existing = delayManager.welcome.get(key)

      if (existing) {
        // 已有待发送队列，将新事件加入队列
        existing.events.push(eventData)
        debugLog(`[${botKey}] Added to existing delay queue, now ${existing.events.length} events`)

        // 根据延迟模式决定是否重置定时器
        if (botConfig.delayMode === 'sliding') {
          // 滑动窗口：取消旧定时器，重新开始计时
          clearTimeout(existing.timer)
          existing.timer = setTimeout(() => processDelayedWelcome(botKey, guildId), groupConfig.delaySeconds * 1000)
          debugLog(`[${botKey}] Sliding mode: timer reset`)
        }
        // fixed 模式：不重置定时器，保持原有的发送时间
      } else {
        // 创建新的延迟队列
        const timer = setTimeout(() => processDelayedWelcome(botKey, guildId), groupConfig.delaySeconds * 1000)
        delayManager.welcome.set(key, {
          events: [eventData],
          timer,
          groupConfig,
          botKey,
          session,
        })
        debugLog(`[${botKey}] Created new delay queue for guild ${session.guildId}`)
      }
    } else {
      // 不启用延迟，立即发送
      try {
        const message = await formatMessage(ctx, session, groupConfig.message, config.resource)
        await sendMessage(session, message)
        logger.info(`[${botKey}] Welcome message sent for guild ${guildId}`)
        verboseLog(`[${botKey}] Message content: ${groupConfig.message}`)
      } catch (error) {
        logger.error(`[${botKey}] Failed to send welcome message:`, error)
      }
    }
  })

  ctx.on('guild-member-removed', async (session) => {
    // 在事件入口就记录详细信息
    verboseLog(`[EVENT] guild-member-removed - selfId: ${session.selfId}, platform: ${session.platform}, guild: ${session.guildId}, user: ${session.userId}`)

    const guildId = session.guildId
    const userId = session.userId

    if (!guildId || !userId) {
      verboseLog(`[EVENT] guild-member-removed missing guildId or userId`)
      return
    }

    const botKey = getBotKey(session.platform || '', session.selfId || '')
    const botConfig = getBotConfig(session.platform || '', session.selfId || '')

    debugLog(`[${botKey}] Processing guild-member-removed event`)

    // 检查配置是否存在
    if (!botConfig) {
      verboseLog(`[${botKey}] No config found for this bot in plugin`)
      debugLog(`[${botKey}] 若要为该 Bot 配置消息，请将「平台名称」填写为 "${session.platform}"，「Bot 自身账号 ID」填写为 "${session.selfId}"`)
      return
    }

    // 检查配置有效性
    if (!isBotConfigValid(botConfig)) {
      verboseLog(`[${botKey}] Config exists but no messages configured`)
      return
    }

    // 检查群组配置
    const groupConfig = botConfig.leaveMessages.find(m => m.guildId === guildId)
    if (!groupConfig) {
      verboseLog(`[${botKey}] No leave config for guild ${guildId}`)
      return
    }

    if (!groupConfig.message) {
      verboseLog(`[${botKey}] Leave config exists for guild ${guildId} but message is empty`)
      return
    }

    // 收集事件数据
    const eventData: LeaveEventData = {
      userId,
      userName: await getUserName(session),
      timestamp: Date.now(),
    }

    // 检查是否启用延迟发送
    if (groupConfig.delaySeconds > 0) {
      verboseLog(`[${botKey}] Delay enabled for guild ${guildId}, waiting ${groupConfig.delaySeconds}s`)

      // 使用复合 key 确保每个 bot 的队列独立
      const key = getDelayKey(botKey, guildId)

      // 检查是否已有待发送的队列
      const existing = delayManager.leave.get(key)

      if (existing) {
        // 已有待发送队列，将新事件加入队列
        existing.events.push(eventData)
        debugLog(`[${botKey}] Added to existing delay queue, now ${existing.events.length} events`)

        // 根据延迟模式决定是否重置定时器
        if (botConfig.delayMode === 'sliding') {
          // 滑动窗口：取消旧定时器，重新开始计时
          clearTimeout(existing.timer)
          existing.timer = setTimeout(() => processDelayedLeave(botKey, guildId), groupConfig.delaySeconds * 1000)
          debugLog(`[${botKey}] Sliding mode: timer reset`)
        }
        // fixed 模式：不重置定时器，保持原有的发送时间
      } else {
        // 创建新的延迟队列
        const timer = setTimeout(() => processDelayedLeave(botKey, guildId), groupConfig.delaySeconds * 1000)
        delayManager.leave.set(key, {
          events: [eventData],
          timer,
          groupConfig,
          botKey,
          session,
        })
        debugLog(`[${botKey}] Created new delay queue for guild ${session.guildId}`)
      }
    } else {
      // 不启用延迟，立即发送
      try {
        const message = await formatMessage(ctx, session, groupConfig.message, config.resource)
        await sendMessage(session, message)
        logger.info(`[${botKey}] Leave message sent for guild ${guildId}`)
        verboseLog(`[${botKey}] Message content: ${groupConfig.message}`)
      } catch (error) {
        logger.error(`[${botKey}] Failed to send leave message:`, error)
      }
    }
  })

  ctx.on('ready', () => {
    logger.info('Plugin ready')
    debugLog('Plugin initialization complete')

    verboseLog(`当前在线 Bot: ${listOnlineBots()}`)

    // 输出当前配置状态
    const configuredBots = config.bots.filter(b => isBotConfigValid(b))
    verboseLog('=== Plugin Configuration Summary ===')
    verboseLog(`Total configured bots: ${config.bots.length}`)
    verboseLog(`Active bots (with messages): ${configuredBots.length}`)

    for (const bot of config.bots) {
      verboseLog(`Bot: ${bot.platform}:${bot.botId}`)
      verboseLog(`  Welcome messages: ${bot.welcomeMessages.length}`)
      for (const msg of bot.welcomeMessages) {
        const preview = msg.message.length > 20 ? msg.message.substring(0, 20) + '...' : msg.message
        const delayInfo = msg.delaySeconds > 0 ? ` [delay: ${msg.delaySeconds}s]` : ''
        verboseLog(`    - Guild ${msg.guildId}: "${preview}"${delayInfo}`)
      }
      verboseLog(`  Leave messages: ${bot.leaveMessages.length}`)
      for (const msg of bot.leaveMessages) {
        const preview = msg.message.length > 20 ? msg.message.substring(0, 20) + '...' : msg.message
        const delayInfo = msg.delaySeconds > 0 ? ` [delay: ${msg.delaySeconds}s]` : ''
        verboseLog(`    - Guild ${msg.guildId}: "${preview}"${delayInfo}`)
      }
    }
    verboseLog('=====================================')
  })

  // 插件停用时清理所有定时器
  ctx.on('dispose', () => {
    logger.info('Cleaning up delay managers...')

    for (const pending of delayManager.welcome.values()) {
      clearTimeout(pending.timer)
    }
    delayManager.welcome.clear()

    for (const pending of delayManager.leave.values()) {
      clearTimeout(pending.timer)
    }
    delayManager.leave.clear()

    logger.info('Delay managers cleaned up')
  })
}
