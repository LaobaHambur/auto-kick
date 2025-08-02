import { Context, Schema, Logger } from 'koishi'

export const name = 'auto-kick'

export const usage = `
## 功能说明
高性能自动踢出指定的黑名单用户，支持大规模群组监控：
- 支持 QQ 号黑名单和昵称关键词黑名单
- 新成员进群后延迟检查昵称变更
- 优化的黑名单匹配算法 (O(1) 查找)
- 昵称支持包含匹配和正则表达式匹配
- 批量扫描和限流控制
- 并发控制和错误重试
- 踢人结果验证，防止权限不足时的误报

## 使用方法
1. 在配置中添加要屏蔽的 QQ 号
2. 在配置中添加要屏蔽的昵称关键词（如 "群主"、"管理员"）
3. 选择昵称匹配模式：包含匹配（默认）或正则表达式
4. 启用延迟昵称检查功能，防止用户进群后改名违规
5. 使用 Koishi 的群组过滤器选择需要监控的群
6. 启用插件即可自动工作

## 工作原理
- **机器人进群时**：自动扫描现有群成员，踢出黑名单用户
- **新成员加入时**：实时检查新加入的成员，发现黑名单用户立即踢出
- **延迟昵称检查**：新成员进群5分钟后检查昵称是否变更为违规内容
- **验证机制**：踢人后验证用户是否真的被踢出，确保操作成功
`

/**
 * 性能统计信息
 */
export interface Stats {
  totalScanned: number
  totalKicked: number
  totalFailed: number
  lastScanTime: number
  averageScanTime: number
}

/**
 * 插件配置接口
 */
export interface Config {
  blacklist: string[]
  nicknameBlacklist: string[]
  enableJoinScan: boolean
  enableMemberJoin: boolean
  enableDelayedNicknameCheck: boolean
  delayedCheckTime: number
  kickFailMessage: string
  notifyAdmins: boolean
  adminNotifyMessage: string
  logLevel: 'debug' | 'info' | 'warn' | 'error'

  // 性能优化配置
  scanDelay: number
  batchSize: number
  maxConcurrent: number
  kickDelay: number
  retryAttempts: number
  retryDelay: number

  // 高级配置
  enableStats: boolean
  skipBotMembers: boolean
  verifyKickResult: boolean
  verifyDelay: number
  verifyTimeout: number
  nicknameMatchMode: 'contains' | 'regex'
}

/**
 * 插件配置Schema
 */
export const Config = Schema.intersect([
  // 基础配置
  Schema.object({
    blacklist: Schema.array(String).role('table').description('黑名单QQ号列表').default([]),

    nicknameBlacklist: Schema.array(String).role('table').description('昵称黑名单关键词列表（如"群主"、"管理员"）').default([]),

    enableJoinScan: Schema.boolean().description('机器人进群时扫描现有成员').default(true),
    enableMemberJoin: Schema.boolean().description('监听新成员加入').default(true),
    enableDelayedNicknameCheck: Schema.boolean().description('新成员加入后延迟检查昵称变更').default(true),
    delayedCheckTime: Schema.number().description('延迟检查时间(毫秒)').default(300000),

    kickFailMessage: Schema.string()
      .description('踢人失败时的提醒消息 (支持 {user} 和 {reason} 占位符)')
      .default('检测到黑名单用户 {user}，但权限不足无法踢出 (原因: {reason})'),

    notifyAdmins: Schema.boolean().description('是否通知管理员黑名单用户行为').default(false),
    adminNotifyMessage: Schema.string()
      .description('通知管理员的消息模板 (支持 {user} 和 {reason} 占位符)')
      .default('管理员注意：检测到黑名单用户 {user} 尝试进入群聊 (原因: {reason})'),

    logLevel: Schema.union([
      Schema.const('debug').description('调试'),
      Schema.const('info').description('信息'),
      Schema.const('warn').description('警告'),
      Schema.const('error').description('错误')
    ]).description('日志级别').default('info')
  }).description('基础设置'),

  // 性能配置
  Schema.object({
    scanDelay: Schema.number().description('机器人进群后延迟扫描时间(毫秒)').default(5000),
    batchSize: Schema.number().description('批量处理成员数量').default(50),
    maxConcurrent: Schema.number().description('最大并发踢人数量').default(3),
    kickDelay: Schema.number().description('踢人操作间隔(毫秒)').default(2000),
    retryAttempts: Schema.number().description('失败重试次数').default(3),
    retryDelay: Schema.number().description('重试延迟(毫秒)').default(5000)
  }).description('性能优化设置'),

  // 高级功能
  Schema.object({
    enableStats: Schema.boolean().description('启用性能统计').default(true),
    skipBotMembers: Schema.boolean().description('跳过机器人成员').default(true),
    verifyKickResult: Schema.boolean().description('验证踢人结果(检查用户是否真的被踢出)').default(true),
    verifyDelay: Schema.number().description('踢人后验证延迟(毫秒)').default(2000),
    verifyTimeout: Schema.number().description('验证超时时间(毫秒)').default(10000),
    nicknameMatchMode: Schema.union([
      Schema.const('contains').description('包含匹配'),
      Schema.const('regex').description('正则表达式')
    ]).description('昵称匹配模式').default('contains')
  }).description('高级功能设置')
])

/**
 * 高性能黑名单管理器
 */
class BlacklistManager {
  private blacklistSet: Set<string>
  private nicknameBlacklist: string[]
  private stats: Stats

  constructor(blacklist: string[], nicknameBlacklist: string[]) {
    this.blacklistSet = new Set()
    this.nicknameBlacklist = []
    this.stats = {
      totalScanned: 0,
      totalKicked: 0,
      totalFailed: 0,
      lastScanTime: 0,
      averageScanTime: 0
    }

    this.updateBlacklist(blacklist, nicknameBlacklist)
  }

  updateBlacklist(blacklist: string[], nicknameBlacklist: string[]) {
    // 更新QQ号黑名单
    this.blacklistSet.clear()
    const validEntries = blacklist.filter(userId => userId && userId.trim().length > 0)
    const uniqueEntries = [...new Set(validEntries.map(userId => userId.trim()))]

    for (const userId of uniqueEntries) {
      this.blacklistSet.add(userId)
    }

    // 更新昵称黑名单
    this.nicknameBlacklist = nicknameBlacklist
      .filter(keyword => keyword && keyword.trim().length > 0)
      .map(keyword => keyword.trim())
  }

  isBlacklisted(userId: string): boolean {
    return this.blacklistSet.has(userId)
  }

  isNicknameBlacklisted(nickname: string, matchMode: 'contains' | 'regex'): { isBlacklisted: boolean, matchedKeyword?: string } {
    if (!nickname || this.nicknameBlacklist.length === 0) {
      return { isBlacklisted: false }
    }

    for (const keyword of this.nicknameBlacklist) {
      try {
        if (matchMode === 'regex') {
          const regex = new RegExp(keyword, 'i')
          if (regex.test(nickname)) {
            return { isBlacklisted: true, matchedKeyword: keyword }
          }
        } else {
          if (nickname.toLowerCase().includes(keyword.toLowerCase())) {
            return { isBlacklisted: true, matchedKeyword: keyword }
          }
        }
      } catch (error) {
        // 正则表达式语法错误时，降级为包含匹配
        if (nickname.toLowerCase().includes(keyword.toLowerCase())) {
          return { isBlacklisted: true, matchedKeyword: keyword }
        }
      }
    }

    return { isBlacklisted: false }
  }

  getStats(): Stats {
    return { ...this.stats }
  }

  updateStats(scanned: number, kicked: number, failed: number, scanTime: number) {
    this.stats.totalScanned += scanned
    this.stats.totalKicked += kicked
    this.stats.totalFailed += failed
    this.stats.lastScanTime = scanTime

    const totalScans = Math.max(1, this.stats.totalScanned / Math.max(1, scanned))
    this.stats.averageScanTime = (this.stats.averageScanTime * (totalScans - 1) + scanTime) / totalScans
  }

  size(): number {
    return this.blacklistSet.size
  }

  nicknameSize(): number {
    return this.nicknameBlacklist.length
  }
}

/**
 * 并发控制器
 */
class ConcurrencyController {
  private running: number = 0
  private queue: Array<() => Promise<void>> = []

  constructor(private maxConcurrent: number) {}

  async execute<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await task()
          resolve(result)
        } catch (error) {
          reject(error)
        }
      })
      this.processQueue()
    })
  }

  private async processQueue() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return
    }

    this.running++
    const task = this.queue.shift()!

    try {
      await task()
    } finally {
      this.running--
      this.processQueue()
    }
  }
}

export function apply(ctx: Context, config: Config) {
  const logger = new Logger(name)
  logger.level = Logger[config.logLevel.toUpperCase()]

  // 初始化管理器
  const blacklistManager = new BlacklistManager(config.blacklist, config.nicknameBlacklist)
  const concurrencyController = new ConcurrencyController(config.maxConcurrent)

  // 新用户昵称缓存 - 用于延迟检查
  const newUserNicknameCache = new Map<string, { nickname: string, guildId: string, joinTime: number }>()

  // 定时更新黑名单管理器
  const configCheckInterval = setInterval(() => {
    blacklistManager.updateBlacklist(config.blacklist, config.nicknameBlacklist)
  }, 60000)

  /**
   * 获取用户昵称
   */
  function getUserNickname(member: any, session?: any): string | null {
    let nickname = null

    // 尝试从member对象获取昵称
    if (member) {
      const memberFields = ['user.name', 'user.username', 'nick', 'nickname', 'displayName']

      for (const field of memberFields) {
        const keys = field.split('.')
        let value = member
        for (const key of keys) {
          value = value?.[key]
        }
        if (value && typeof value === 'string' && value.trim()) {
          nickname = value.trim()
          break
        }
      }
    }

    // 尝试从session获取昵称
    if (!nickname && session) {
      const sessionFields = ['username', 'author.name', 'user.name']

      for (const field of sessionFields) {
        const keys = field.split('.')
        let value = session
        for (const key of keys) {
          value = value?.[key]
        }
        if (value && typeof value === 'string' && value.trim()) {
          nickname = value.trim()
          break
        }
      }
    }

    return nickname
  }

  /**
   * 验证用户是否被踢出
   */
  async function verifyUserKicked(session: any, userId: string): Promise<boolean> {
    try {
      const members = await session.bot.getGuildMemberList(session.guildId)
      const memberList = members.data || []
      return memberList.some(member => member.user.id === userId)
    } catch (error) {
      try {
        const member = await session.bot.getGuildMember(session.guildId, userId)
        return !!member
      } catch (memberError) {
        if (memberError.message?.includes('not found') ||
            memberError.message?.includes('用户不存在')) {
          return false
        }
        throw memberError
      }
    }
  }

  /**
   * 带重试和验证的踢人操作
   */
  async function kickUserWithRetry(session: any, userId: string, displayName: string): Promise<boolean> {
    for (let i = 0; i < config.retryAttempts; i++) {
      try {
        await session.bot.kickGuildMember(session.guildId, userId)

        if (config.verifyKickResult) {
          await new Promise(resolve => setTimeout(resolve, config.verifyDelay))
          const isStillInGroup = await verifyUserKicked(session, userId)
          if (!isStillInGroup) {
            return true
          }

          if (i === config.retryAttempts - 1) {
            await session.send(`⚠️ 检测到黑名单用户 ${displayName}，已尝试踢出但用户仍在群里，请检查机器人权限`)
            return false
          }
          throw new Error('踢人API调用成功但用户仍在群里')
        } else {
          return true
        }
      } catch (error) {
        if (i < config.retryAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, config.retryDelay))
        } else {
          await session.send(`⚠️ 检测到黑名单用户 ${displayName}，踢人失败，请检查机器人权限`)
        }
      }
    }
    return false
  }

  /**
   * 检查并踢出黑名单用户
   */
  async function checkAndKickUser(session: any, userId: string, nickname?: string): Promise<boolean> {
    const displayName = nickname || userId
    let kickReason = ''
    let shouldKick = false

    // 检查QQ号黑名单
    if (blacklistManager.isBlacklisted(userId)) {
      shouldKick = true
      kickReason = 'QQ号黑名单'
    }

    // 检查昵称黑名单
    if (!shouldKick && nickname) {
      const nicknameCheck = blacklistManager.isNicknameBlacklisted(nickname, config.nicknameMatchMode)
      if (nicknameCheck.isBlacklisted) {
        shouldKick = true
        kickReason = `昵称黑名单 (匹配: ${nicknameCheck.matchedKeyword})`
      }
    }

    if (!shouldKick) {
      return false
    }

    logger.info(`🎯 发现黑名单用户: ${displayName} (${userId}) - ${kickReason}`)

    // 通知管理员
    if (config.notifyAdmins) {
      const notifyMessage = config.adminNotifyMessage
        .replace('{user}', displayName)
        .replace('{reason}', kickReason)
      try {
        await session.send(notifyMessage)
      } catch (error) {
        logger.warn(`发送管理员通知失败: ${error.message}`)
      }
    }

    // 并发控制踢人操作
    const kickSuccess = await concurrencyController.execute(async () => {
      const success = await kickUserWithRetry(session, userId, displayName)
      if (success) {
        logger.info(`✅ 成功踢出: ${displayName} (${userId}) - ${kickReason}`)
      } else {
        logger.warn(`❌ 踢出失败: ${displayName} (${userId}) - ${kickReason}`)
      }
      return success
    })

    return kickSuccess
  }

  /**
   * 延迟检查用户昵称变更
   */
  async function delayedNicknameCheck(userId: string, guildId: string, originalNickname: string, bot: any) {
    try {
      const memberInfo = await bot.getGuildMember(guildId, userId)

      if (!memberInfo) {
        newUserNicknameCache.delete(userId)
        return
      }

      const currentNickname = getUserNickname(memberInfo)

      // 检查昵称是否发生变化
      if (currentNickname && currentNickname !== originalNickname && currentNickname !== userId) {
        logger.info(`🔄 检测到用户昵称变更: ${userId} "${originalNickname}" -> "${currentNickname}"`)

        // 检查新昵称是否违规
        const nicknameCheck = blacklistManager.isNicknameBlacklisted(currentNickname, config.nicknameMatchMode)
        if (nicknameCheck.isBlacklisted) {
          logger.info(`🎯 变更后的昵称 "${currentNickname}" 违规 (匹配: ${nicknameCheck.matchedKeyword})`)

          const kickSession = { guildId, userId, bot }
          await checkAndKickUser(kickSession as any, userId, currentNickname)
        }
      }

      newUserNicknameCache.delete(userId)

    } catch (error) {
      logger.warn(`延迟检查用户 ${userId} 昵称失败: ${error.message}`)
      newUserNicknameCache.delete(userId)
    }
  }

  /**
   * 批量扫描群成员
   */
  async function scanExistingMembers(session: any) {
    if (!config.enableJoinScan) return

    const startTime = Date.now()
    logger.info(`🔍 开始扫描群 ${session.guildId}`)

    try {
      const members = await session.bot.getGuildMemberList(session.guildId)
      const memberList = members.data || []

      let scannedCount = 0
      let blacklistedCount = 0
      let kickedCount = 0
      let failedKickCount = 0

      const filteredMembers = config.skipBotMembers
        ? memberList.filter(member => !member.user.isBot)
        : memberList

      for (let i = 0; i < filteredMembers.length; i += config.batchSize) {
        const batch = filteredMembers.slice(i, i + config.batchSize)

        for (const member of batch) {
          scannedCount++

          const userId = member.user.id
          const nickname = getUserNickname(member)

          // 检查是否需要踢出
          let shouldKick = false
          let kickReason = ''

          if (blacklistManager.isBlacklisted(userId)) {
            shouldKick = true
            kickReason = 'QQ号黑名单'
          } else if (nickname) {
            const nicknameCheck = blacklistManager.isNicknameBlacklisted(nickname, config.nicknameMatchMode)
            if (nicknameCheck.isBlacklisted) {
              shouldKick = true
              kickReason = `昵称黑名单 (${nicknameCheck.matchedKeyword})`
            }
          }

          if (shouldKick) {
            blacklistedCount++
            const kickResult = await checkAndKickUser(session, userId, nickname)
            if (kickResult) {
              kickedCount++
            } else {
              failedKickCount++
            }
          }

          if (blacklistedCount > 0 && scannedCount % config.maxConcurrent === 0) {
            await new Promise(resolve => setTimeout(resolve, config.kickDelay))
          }
        }

        if (i + config.batchSize < filteredMembers.length) {
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }

      const scanTime = Date.now() - startTime

      if (config.enableStats) {
        blacklistManager.updateStats(scannedCount, kickedCount, failedKickCount, scanTime)
      }

      if (blacklistedCount > 0) {
        logger.info(`📊 扫描完成: 检查 ${scannedCount} 人, 发现黑名单 ${blacklistedCount} 人, 成功踢出 ${kickedCount} 人, 失败 ${failedKickCount} 人, 耗时 ${scanTime}ms`)
      } else {
        logger.info(`✅ 扫描完成: 检查 ${scannedCount} 人, 未发现黑名单用户, 耗时 ${scanTime}ms`)
      }

    } catch (error) {
      logger.error(`扫描群成员失败: ${error.message}`)
    }
  }

  // 监听机器人加入群聊事件
  ctx.on('guild-added', async (session) => {
    logger.info(`🏠 机器人加入群聊: ${session.guildId}`)
    setTimeout(() => {
      scanExistingMembers(session)
    }, config.scanDelay)
  })

  // 监听群成员加入事件
  ctx.on('guild-member-added', async (session) => {
    if (!config.enableMemberJoin) return

    const userId = session.userId

    logger.info(`👤 新成员加入: ${userId}`)

    if (config.skipBotMembers && session.author?.isBot) {
      return
    }

    // 获取昵称
    let nickname = getUserNickname(null, session)

    if (!nickname || nickname === userId) {
      if (session.guildId) {
        try {
          const memberInfo = await session.bot.getGuildMember(session.guildId, userId)
          const apiNickname = getUserNickname(memberInfo)
          if (apiNickname && apiNickname !== userId) {
            nickname = apiNickname
          }
        } catch (error) {
          logger.debug(`API获取成员信息失败: ${error.message}`)
        }
      }
    }

    if (!nickname || nickname === userId) {
      try {
        const userInfo = await session.bot.getUser(userId)
        const userNickname = userInfo?.name || userInfo?.username || null
        if (userNickname && userNickname !== userId) {
          nickname = userNickname
        }
      } catch (error) {
        logger.debug(`获取用户信息失败: ${error.message}`)
      }
    }

    if (!nickname || nickname === userId) {
      if (blacklistManager.isBlacklisted(userId)) {
        await checkAndKickUser(session, userId, null)
        return
      }
      nickname = userId
    }

    logger.info(`👤 新成员: ${nickname} (${userId})`)

    // 立即检查当前昵称
    const immediateCheckResult = await checkAndKickUser(session, userId, nickname)

    // 如果没有被立即踢出，且启用了延迟检查，则设置延迟检查
    if (!immediateCheckResult && config.enableDelayedNicknameCheck && nickname !== userId) {
      logger.info(`⏰ 设置用户 ${userId} 延迟昵称检查 (${config.delayedCheckTime/1000}秒)`)

      newUserNicknameCache.set(userId, {
        nickname: nickname,
        guildId: session.guildId,
        joinTime: Date.now()
      })

      setTimeout(() => {
        delayedNicknameCheck(userId, session.guildId, nickname, session.bot)
      }, config.delayedCheckTime)
    }
  })

  logger.info(`🚀 Auto-kick 插件启动成功`)
  logger.info(`📋 QQ号黑名单: ${blacklistManager.size()} 个`)
  logger.info(`👤 昵称关键词: ${blacklistManager.nicknameSize()} 个 [${config.nicknameBlacklist.join(', ')}]`)
  logger.info(`⚙️ 匹配模式: ${config.nicknameMatchMode}, 验证踢人: ${config.verifyKickResult ? '✅' : '❌'}`)
  logger.info(`⏰ 延迟昵称检查: ${config.enableDelayedNicknameCheck ? `✅ ${config.delayedCheckTime/1000}秒` : '❌ 未启用'}`)

  if (config.enableDelayedNicknameCheck) {
    logger.info(`💡 新成员进群后将在 ${config.delayedCheckTime/1000} 秒后检查昵称变更`)
  }

  // 插件卸载时清理资源
  ctx.on('dispose', () => {
    clearInterval(configCheckInterval)
    newUserNicknameCache.clear()
  })
}
