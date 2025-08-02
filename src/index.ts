import { Context, Schema, Logger, h } from 'koishi'

export const name = 'auto-kick'
export const usage = `
## 功能说明
自动踢出指定的黑名单用户，支持：
- 机器人进群时扫描现有成员
- 监听新成员加入并自动检测
- 权限不足时发送提醒消息

## 使用方法
1. 在配置中添加要屏蔽的 QQ 号
2. 确保机器人有群管理员权限
3. 启用插件即可自动工作
`

// 配置 Schema
export interface Config {
  blacklist: string[]
  enableJoinScan: boolean
  enableMemberJoin: boolean
  kickFailMessage: string
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export const Config: Schema<Config> = Schema.object({
  blacklist: Schema.array(String).role('table').description('黑名单 QQ 号列表').default([]),
  enableJoinScan: Schema.boolean().description('机器人进群时扫描现有成员').default(true),
  enableMemberJoin: Schema.boolean().description('监听新成员加入').default(true),
  kickFailMessage: Schema.string().description('踢人失败时的提醒消息').default('检测到黑名单用户 {user}，但权限不足无法踢出'),
  logLevel: Schema.union(['debug', 'info', 'warn', 'error']).description('日志级别').default('info')
})

export function apply(ctx: Context, config: Config) {
  const logger = new Logger(name)

  // 设置日志级别
  logger.level = Logger[config.logLevel.toUpperCase()]

  // 检查黑名单用户的核心函数
  async function checkAndKickUser(session: any, userId: string, username?: string) {
    if (!config.blacklist.includes(userId)) {
      return false
    }

    logger.info(`检测到黑名单用户: ${username || userId} (${userId})`)

    try {
      // 尝试踢出用户
      await session.bot.kickGuildMember(session.guildId, userId)
      logger.info(`成功踢出黑名单用户: ${username || userId} (${userId})`)
      return true
    } catch (error) {
      logger.warn(`踢出用户失败: ${error.message}`)

      // 发送提醒消息
      const message = config.kickFailMessage.replace('{user}', username || userId)
      await session.send(message)
      return false
    }
  }

  // 扫描群内现有成员
  async function scanExistingMembers(session: any) {
    if (!config.enableJoinScan) return

    logger.info(`开始扫描群 ${session.guildId} 的现有成员`)

    try {
      const members = await session.bot.getGuildMemberList(session.guildId)
      let kickedCount = 0

      for (const member of members.data) {
        if (await checkAndKickUser(session, member.user.id, member.user.name)) {
          kickedCount++
        }
      }

      if (kickedCount > 0) {
        logger.info(`群扫描完成，踢出 ${kickedCount} 个黑名单用户`)
      } else {
        logger.debug(`群扫描完成，未发现黑名单用户`)
      }
    } catch (error) {
      logger.error(`扫描群成员失败: ${error.message}`)
    }
  }

  // 监听机器人加入群聊事件
  ctx.on('guild-added', async (session) => {
    logger.info(`机器人加入群聊: ${session.guildId}`)

    // 延迟一段时间后执行扫描，确保权限已经生效
    setTimeout(() => {
      scanExistingMembers(session)
    }, 3000)
  })

  // 监听群成员加入事件
  ctx.on('guild-member-added', async (session) => {
    if (!config.enableMemberJoin) return

    const userId = session.userId
    const username = session.username

    logger.debug(`新成员加入群聊: ${username || userId} (${userId})`)

    // 检查并处理黑名单用户
    await checkAndKickUser(session, userId, username)
  })

  // 手动扫描命令 (可选)
  ctx.command('auto-kick.scan', '手动扫描当前群的黑名单用户')
    .alias('ak.scan')
    .action(async ({ session }) => {
      if (!session.guildId) {
        return '此命令只能在群聊中使用'
      }

      await session.send('开始扫描群内黑名单用户...')
      await scanExistingMembers(session)
      return '扫描完成'
    })

  // 添加黑名单命令
  ctx.command('auto-kick.add <qq:string>', '添加 QQ 号到黑名单')
    .alias('ak.add')
    .example('auto-kick.add 123456789')
    .action(async ({ session }, qq) => {
      if (!qq) return '请提供要添加的 QQ 号'

      if (config.blacklist.includes(qq)) {
        return `QQ 号 ${qq} 已在黑名单中`
      }

      config.blacklist.push(qq)
      logger.info(`管理员 ${session.userId} 添加黑名单用户: ${qq}`)
      return `已将 QQ 号 ${qq} 添加到黑名单`
    })

  // 移除黑名单命令
  ctx.command('auto-kick.remove <qq:string>', '从黑名单中移除 QQ 号')
    .alias('ak.remove')
    .example('auto-kick.remove 123456789')
    .action(async ({ session }, qq) => {
      if (!qq) return '请提供要移除的 QQ 号'

      const index = config.blacklist.indexOf(qq)
      if (index === -1) {
        return `QQ 号 ${qq} 不在黑名单中`
      }

      config.blacklist.splice(index, 1)
      logger.info(`管理员 ${session.userId} 移除黑名单用户: ${qq}`)
      return `已将 QQ 号 ${qq} 从黑名单中移除`
    })

  // 查看黑名单命令
  ctx.command('auto-kick.list', '查看当前黑名单')
    .alias('ak.list')
    .action(() => {
      if (config.blacklist.length === 0) {
        return '黑名单为空'
      }
      return `当前黑名单 (${config.blacklist.length} 个):\n${config.blacklist.join('\n')}`
    })

  logger.info(`Auto-kick 插件已启动，监控 ${config.blacklist.length} 个黑名单用户`)
}
