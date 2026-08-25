/**
 * Minecraft 假人（mineflayer）
 *
 * 行为流程：
 *  1. 进服 1.5s 后 /login <PSW>，1s 后 /home work，开始主循环
 *  2. 寻找 50 格内的 mooshroom/cow（mooshroom 优先、取最近），寻路保持 ≥2 格距离，
 *     切剑攻击直到目标死亡；拾取死亡 3 秒内、距死亡位置 2 格内的掉落物
 *  2a. 移动修复：寻路开始前先面向目标，寻路中每 150ms 面向下一路径节点（移动方向），
 *     并带卡住检测日志（部分服务器要求玩家面向移动方向才允许移动）
 *  2b. 击杀归属：只拾取假人自己参与击杀（最后攻击该目标 4 秒内死亡）的掉落物，
 *     其他玩家打死的牛/蘑菇牛掉落物不捡
 *  3. 避让其他玩家（靠近玩家的方向寻路权重降低，但非完全不可通行）
 *  4. 物品栏满 → 先寻路到“周围 5 格内无目标”的安全位置，再 /home cangku →
 *     以系统聊天出现“传送完成”判定传送成功（部分匹配，未收到则重试；期间不移动、
 *     原地攻击附近目标、不捡掉落物）；传送成功后打开 barrel 把背包中除盔甲/剑/
 *     熟猪肉外所有物品移入容器（限速 4 次/秒），容器满则每秒查看、10s 后每 10s 查看；
 *     放完后 /back，同样以“传送完成”提示为准，超时重试
 *  5. 生命<12 且饱和度<=19，或饱食度<16 时，把熟猪肉放入副手（不在副手才手动放），
 *     食用直到数量减少，5s 冷却；熟猪肉耗尽则下线
 *  6. 死亡 → /back 等 3.5s 继续
 */
require('dotenv').config({ quiet: true })

const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')

// goals 兼容 mineflayer-pathfinder 2.4+（独立子模块）与旧版本
let goalsMod
try {
  goalsMod = require('mineflayer-pathfinder/goals')
} catch {
  goalsMod = require('mineflayer-pathfinder').goals
}
const { GoalNear, GoalFollow } = goalsMod

// ---------------- 配置（.env） ----------------
const HOST = process.env.HOST || 'localhost'
const PORT = parseInt(process.env.PORT || '25565', 10)
// 注意：不能用 USERNAME —— 它是 Windows 内置环境变量（当前登录用户名），
// dotenv 不会覆盖已存在的环境变量，导致 .env 里的用户名永远不生效。
const BOT_USERNAME = process.env.BOT_USERNAME || 'XQYXQY'
const VERSION = process.env.VERSION || '1.21.11'
const AUTH = process.env.AUTH || 'offline'
const PSW = process.env.PSW
if (!PSW) {
  console.error('[启动失败] 缺少环境变量 PSW（AuthMe /login 密码），请在 .env 中配置后重启')
  process.exit(1)
}

// 网页监控配置
const WEB_PORT = parseInt(process.env.WEB_PORT || '3000', 10)
const VIEWER_PORT = parseInt(process.env.VIEWER_PORT || '3001', 10)
// --auto-start：带该参数则登录后直接开始工作；否则登录后待机，等待网页唤醒
const AUTO_START = process.argv.includes('--auto-start')
// 移动调试开关（排查“假人无法移动”用，正常运行不需要设置）
const NO_SPRINT = process.env.NO_SPRINT === '1'              // 禁用疾跑
const FORCE_ON_GROUND = process.env.FORCE_ON_GROUND === '1'  // 移动包强制 onGround=true
const NO_WARP = process.env.NO_WARP === '1'                  // 跳过 /warp（出生点即工作点时用）

// ---------------- 常量 ----------------
const TARGET_RADIUS = 50          // 目标搜索半径（格）
const STANDOFF = 2.5              // 与目标保持的距离（≥2 格）
const ATTACK_RANGE = 3.2          // 剑的攻击距离
const ATTACK_INTERVAL = 900       // 两次攻击的最小间隔 ms
const DROP_WINDOW_MS = 3000       // 掉落物判定：目标死亡后 3 秒内
const DROP_RADIUS = 2             // 掉落物判定：距死亡位置 < 2 格
const KILL_CLAIM_MS = 4000        // 击杀归属：最后攻击该目标 4 秒内死亡 → 视为假人击杀
const FACING_TICK_MS = 150        // 寻路中面向移动方向的刷新间隔
const STUCK_CHECK_MS = 1000       // 卡住检测间隔（秒级采样）
const STUCK_LIMIT = 3             // 连续 N 秒未移动视为卡住
const STATUS_LOG_MS = parseInt(process.env.STATUS_LOG_MS || '30000', 10) // 周期状态日志间隔（可用环境变量调细，便于调试）
const DEPOSIT_WAIT_MS = 3500      // /home cangku 与 /back 后的等待时长
const EAT_COOLDOWN_MS = 5000      // 食用后 5 秒内不再食用
const CONTAINER_OP_INTERVAL = 300 // 容器操作限速：两次操作间隔 ≥300ms（一秒最多 4 次，留抖动余量）
const SWORD_NAMES = new Set(['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword'])
const SWORD_RANK = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword']
const TARGET_NAMES = new Set(['cow', 'mooshroom', 'mooshroom_cow'])
const PORKCHOP = 'cooked_porkchop'

// ---------------- 全局状态 ----------------
let bot = null
let state = 'startup'       // startup | hunt | eat | deposit | dead
let running = false
let intentionalQuit = false
let botDead = false
let paused = !AUTO_START    // 待机模式：登录后等待网页唤醒
let mainLoopActive = false  // 主循环是否在运行（避免重复启动）
let lastEatTime = 0
let noPathCount = 0
let noPathFlag = false
const recentDeaths = []     // [{ pos: Vec3, time: number }]
const dropIds = new Set()   // 已确认掉落物的实体 id
const deadIds = new Set()   // 已死亡/消失的实体 id
let avoidPlayers = []       // 需要避让的玩家坐标（定期更新）
let teleportAck = false     // 是否收到系统“传送完成”提示（传送完成判定依据）
const myKills = new Map()   // 假人攻击过的目标: entityId → 最近攻击时间（击杀归属判定）
let currentPath = []        // pathfinder 最近一次计算的路径节点（用于面向移动方向）
let lastPathStatus = null   // 最近一次路径计算状态
let lastGoalDesc = ''       // 当前寻路目标描述（日志用）
let lastMoveCheckPos = null // 卡住检测：上次采样位置
let lastMoveCheckTime = 0   // 卡住检测：上次采样时间
let stuckCount = 0          // 连续未移动的秒数
let stuckLogged = false     // 本次卡住是否已记录日志

// 网页监控：日志/聊天缓冲
const logBuffer = []
const chatBuffer = []
let webApi = null
let viewerCtl = null
let viewerServer = null

const sleep = ms => new Promise(r => setTimeout(r, ms))
function log (...a) {
  const line = `[${new Date().toLocaleTimeString()}] ${a.join(' ')}`
  console.log(line)
  logBuffer.push(line)
  if (logBuffer.length > 300) logBuffer.shift()
  if (webApi) webApi.broadcast({ type: 'log', line })
}

function webBroadcast (msg) { if (webApi) webApi.broadcast(msg) }

// ---------------- 状态切换与面向移动方向 ----------------
/** 切换工作状态并记录日志 */
function setState (s, reason) {
  if (state === s) return
  log(`[状态] ${state} → ${s}${reason ? `（${reason}）` : ''}`)
  state = s
}

/** 面向某位置（移动方向）：force=true 立即生效，随下一个移动包发出 */
function facePosition (pos) {
  if (!bot || !bot.entity || !pos) return
  if (typeof bot.look !== 'function') return
  const dx = pos.x - bot.entity.position.x
  const dz = pos.z - bot.entity.position.z
  if (dx === 0 && dz === 0) return
  bot.look(Math.atan2(-dx, -dz), 0, true).catch(() => {})
}

/** 面向当前路径的下一节点（移动方向） */
function faceNextNode () {
  const n = currentPath[0]
  if (!n) return false
  facePosition({ x: n.x + 0.5, y: bot.entity.position.y, z: n.z + 0.5 })
  return true
}

/** 开始寻路：先面向目标/移动方向，再交给 pathfinder */
function startPath (goal, dynamic, desc) {
  if (goal && goal.entity && goal.entity.position) facePosition(goal.entity.position)
  else if (goal && typeof goal.x === 'number') facePosition({ x: goal.x, y: goal.y, z: goal.z })
  lastGoalDesc = desc || ''
  log(`[移动] 开始寻路${desc ? '：' + desc : ''}，先面向目标方向`)
  bot.pathfinder.setGoal(goal, dynamic)
}

/** 物品实体名称（item 实体的物品信息在 metadata[8]，拿不到返回 null） */
function itemEntityName (e) {
  try {
    const m = e && e.metadata && e.metadata[8]
    if (m && typeof m === 'object') {
      if (m.name) return m.name
      if (m.displayName) return m.displayName
    }
  } catch {}
  return null
}

// 寻路过程中每 150ms 面向移动方向（下一路径节点），并检测卡住
setInterval(() => {
  if (!bot || !bot.entity || paused || botDead) return
  if (!bot.pathfinder || typeof bot.pathfinder.isMoving !== 'function' || !bot.pathfinder.isMoving()) {
    stuckCount = 0
    stuckLogged = false
    return
  }
  faceNextNode()

  const now = Date.now()
  const p = bot.entity.position
  if (!lastMoveCheckPos || now - lastMoveCheckTime >= STUCK_CHECK_MS) {
    const moved = lastMoveCheckPos ? p.distanceTo(lastMoveCheckPos) : 1
    lastMoveCheckPos = p.clone()
    lastMoveCheckTime = now
    if (moved < 0.05) {
      stuckCount++
      if (stuckCount >= STUCK_LIMIT && !stuckLogged) {
        stuckLogged = true
        const n = currentPath[0]
        const p = bot.entity.position
        let diag = `（当前 ${p.floored()}，下一节点 ${n ? n.x + ',' + n.y + ',' + n.z : '无'}）`
        if (n) {
          const reqYaw = Math.atan2(-(n.x + 0.5 - p.x), -(n.z + 0.5 - p.z))
          diag += ` 朝向=${bot.entity.yaw.toFixed(2)} 需朝=${reqYaw.toFixed(2)}`
        }
        if (typeof bot.getControlState === 'function') {
          diag += ` 控制状态=${['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(k => k + ':' + bot.getControlState(k)).join(' ')}`
        }
        diag += ` onGround=${bot.entity.onGround} 脚下=${bot.blockAt(p) ? bot.blockAt(p).name : '?'}`
        log(`[路径] 疑似卡住：${STUCK_LIMIT} 秒内位置几乎未动${diag}${lastGoalDesc ? '，目标: ' + lastGoalDesc : ''}`)
      }
    } else {
      stuckCount = 0
      stuckLogged = false
    }
  }
}, FACING_TICK_MS)

// 周期状态日志（每 30 秒）
setInterval(() => {
  if (!bot || !bot.entity || !running) return
  const pos = bot.entity.position
  const target = findTargetInRange(TARGET_RADIUS)
  const moving = bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' ? bot.pathfinder.isMoving() : false
  log(`[状态] 坐标=${pos.floored()} 朝向=${bot.entity.yaw.toFixed(2)}/${bot.entity.pitch.toFixed(2)} 生命=${bot.health.toFixed(1)} 饱食=${bot.food} 状态=${state}${paused ? '（待机）' : ''} 目标=${target ? target.name + '@' + bot.entity.position.distanceTo(target.position).toFixed(1) + '格' : '无'} 移动中=${moving} 待拾取掉落=${dropIds.size} 实体数=${Object.keys(bot.entities).length}`)
}, STATUS_LOG_MS)

// ---------------- 寻路（靠近玩家的方向权重降低） ----------------
class CustomMovements extends Movements {
  constructor (bot) { super(bot) }

  getCost (node) {
    let cost = super.getCost(node)
    if (cost === Infinity) return cost
    for (const p of avoidPlayers) {
      const dx = node.x - p.x
      const dz = node.z - p.z
      const d = Math.sqrt(dx * dx + dz * dz)
      if (d < 4) cost += (4 - d) * 2 // 玩家 4 格内代价递增：避让但非完全不能靠近
    }
    return cost
  }
}

function updateAvoidPlayers () {
  if (!bot || !bot.entity) return
  avoidPlayers = Object.values(bot.entities)
    .filter(e => e.type === 'player' && e.id !== bot.entity.id && e.position &&
      bot.entity.position.distanceTo(e.position) <= 16)
    .map(e => e.position.clone())
}
setInterval(updateAvoidPlayers, 500)

// ---------------- 工具函数 ----------------
function isTargetEntity (e) {
  return e && e.position && TARGET_NAMES.has(e.name)
}

/** 在指定范围内找目标：mooshroom 优先，同类型取最近 */
function findTargetInRange (range) {
  const candidates = Object.values(bot.entities).filter(e =>
    isTargetEntity(e) && !deadIds.has(e.id) &&
    bot.entity.position.distanceTo(e.position) <= range)
  if (!candidates.length) return null
  const mooshrooms = candidates.filter(e => e.name === 'mooshroom' || e.name === 'mooshroom_cow')
  const pool = mooshrooms.length ? mooshrooms : candidates
  pool.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
  return pool[0]
}

function findTarget () { return findTargetInRange(TARGET_RADIUS) }

/** 物品栏中最好的剑 */
function bestSword () {
  const items = bot.inventory.items().filter(i => i && SWORD_NAMES.has(i.name))
  if (!items.length) return null
  items.sort((a, b) => SWORD_RANK.indexOf(a.name) - SWORD_RANK.indexOf(b.name))
  return items[0]
}

function ensureSword () {
  const held = bot.heldItem
  if (held && SWORD_NAMES.has(held.name)) return
  const sword = bestSword()
  if (sword) {
    bot.equip(sword, 'hand').catch(err => log('装备剑失败:', err.message))
  } else {
    log('警告: 物品栏中没有剑类武器，将空手攻击')
  }
}

/** 物品栏（主物品栏 9-35 + 快捷栏 36-44）是否已满 */
function inventoryFull () {
  const slots = bot.inventory.slots // 数组属性
  for (let i = 9; i < 45; i++) {
    if (!slots[i]) return false
  }
  return true
}

function containerHasSpace (win) {
  return win.slots.slice(0, win.inventoryStart).some(s => !s)
}

/** 下一个要存入容器的物品（只取容器窗口中的玩家区：主物品栏+快捷栏，不含盔甲/副手；跳过剑与熟猪肉） */
function nextDepositItem (win) {
  const slots = win.slots // 数组属性，槽位即容器窗口槽位
  for (let i = win.inventoryStart; i < win.inventoryEnd; i++) {
    const it = slots[i]
    if (!it) continue
    if (SWORD_NAMES.has(it.name)) continue   // 保留剑类武器
    if (it.name === PORKCHOP) continue       // 保留熟猪肉
    return it
  }
  return null
}

function pruneRecentDeaths () {
  while (recentDeaths.length && Date.now() - recentDeaths[0].time > DROP_WINDOW_MS) recentDeaths.shift()
}

/** 暂停/唤醒：暂停时停止寻路并挂起主循环，等待网页唤醒 */
function setPaused (p) {
  paused = !!p
  if (paused) {
    if (bot) {
      bot.pathfinder.setGoal(null)
      // 关闭可能残留的容器窗口，避免唤醒后状态混乱
      if (bot.currentWindow && bot.currentWindow.id !== 0) {
        try { bot.closeWindow(bot.currentWindow) } catch {}
      }
    }
    log('已暂停，等待网页唤醒')
  } else {
    log('已唤醒，开始工作')
    // 若暂停发生在存仓/进食等子流程中，恢复为狩猎状态
    if (!botDead && state !== 'hunt') setState('hunt', '唤醒恢复')
    if (!mainLoopActive && !botDead && state === 'hunt' && running) {
      mainLoopActive = true
      mainLoop().catch(err => log('主循环异常退出:', err && err.stack || err))
    }
  }
  webBroadcast({ type: 'paused', paused })
}

/** 网页状态快照 */
function getStatus () {
  if (!bot || !bot.entity) return null
  const pos = bot.entity.position
  const slots = bot.inventory.slots
  let used = 0
  let porkchop = 0
  for (let i = 9; i < 45; i++) {
    if (slots[i]) used++
  }
  for (const it of bot.inventory.items()) {
    if (it && it.name === PORKCHOP) porkchop += it.count
  }
  const target = findTargetInRange(TARGET_RADIUS)
  const players = Object.values(bot.entities)
    .filter(e => e.type === 'player' && e.id !== bot.entity.id && e.username)
    .map(e => e.username)
  return {
    t: Date.now(),
    pos: { x: pos.x, y: pos.y, z: pos.z, yaw: bot.entity.yaw, pitch: bot.entity.pitch },
    health: bot.health,
    food: bot.food,
    saturation: bot.foodSaturation,
    state,
    paused,
    dimension: bot.game && bot.game.dimension ? bot.game.dimension : null,
    target: target ? { name: target.name, dist: bot.entity.position.distanceTo(target.position) } : null,
    inventory: { used, full: inventoryFull(), sword: bot.heldItem ? bot.heldItem.name : null, porkchop },
    players,
    entities: Object.keys(bot.entities).length,
    drops: dropIds.size,
    uptime: Math.floor(process.uptime())
  }
}

// ---------------- 事件 ----------------
function registerEvents () {
  bot.once('spawn', async () => {
    botDead = false
    log(`已进入服务器（版本 ${bot.version}），1.5 秒后登录`)
    await sleep(1500)
    bot.chat(`/login ${PSW}`)
    log('已发送 /login')
    await sleep(1000)
    // 用 /warp 菜单传送到工作点：等待箱子界面打开 → 拿起第一行第二个物品 → 等 3.5s 传送生效
    // 传送失败则保持待机重试，绝不直接开始工作
    if (NO_WARP) {
      log('NO_WARP=1：跳过 /warp 菜单，直接在出生点开始（出生点即工作点时用）')
    } else if (!(await warpToWork())) {
      log('warp 传送失败（多次重试未成功），保持待机，不开始工作')
      return
    }
    running = true
    setState('hunt', '登录完成')
    if (paused) {
      log('待机模式（未带 --auto-start）：等待网页唤醒')
    } else {
      log('开始主流程')
      mainLoopActive = true
      mainLoop().catch(err => log('主循环异常退出:', err && err.stack || err))
    }
  })

  // 新生成的物品实体：若在某个目标死亡 3 秒内、且距死亡位置 < 2 格 → 判定为掉落物
  bot.on('entitySpawn', e => {
    if (e.name !== 'item' || !e.position) return
    const now = Date.now()
    for (const d of recentDeaths) {
      if (now - d.time <= DROP_WINDOW_MS && d.pos.distanceTo(e.position) < DROP_RADIUS) {
        dropIds.add(e.id)
        const name = itemEntityName(e)
        log(`[掉落] 检测到新掉落物${name ? ' ' + name : ''} @ ${e.position.floored ? e.position.floored() : e.position}`)
        break
      }
    }
  })

  bot.on('entityDead', e => {
    deadIds.add(e.id)
    dropIds.delete(e.id)
    if (isTargetEntity(e)) {
      // 击杀归属：仅当假人最后攻击该目标在 4 秒内，才视为假人击杀并拾取掉落物，
      // 避免抢其他玩家打死的牛/蘑菇牛的掉落物
      const lastAtk = myKills.get(e.id)
      const mine = lastAtk !== undefined && Date.now() - lastAtk <= KILL_CLAIM_MS
      myKills.delete(e.id)
      const where = e.position.floored ? e.position.floored() : e.position
      if (mine) {
        recentDeaths.push({ pos: e.position.clone(), time: Date.now() })
        pruneRecentDeaths()
        log(`[击杀] ${e.name} 死亡 @ ${where}，归属：假人（${((Date.now() - lastAtk) / 1000).toFixed(1)}s 前最后攻击），拾取其掉落物`)
      } else {
        log(`[击杀] ${e.name} 死亡 @ ${where}，归属：其他玩家/非假人所杀，不拾取掉落物`)
      }
    }
  })

  bot.on('entityGone', e => {
    deadIds.delete(e.id)
    dropIds.delete(e.id)
  })

  bot.on('death', () => {
    log('假人死亡')
    // 调试：记录死亡位置与附近实体/方块，便于定位死因
    if (bot.entity) {
      const p = bot.entity.position
      const near = Object.values(bot.entities)
        .filter(e => e.position && e.position.distanceTo(p) < 12)
        .map(e => e.name)
      const block = bot.blockAt(p)
      log(`死亡位置 ${p.floored()}，站立方块: ${block ? block.name : '?'}，附近实体: ${[...new Set(near)].slice(0, 15).join(',') || '无'}`)
    }
    botDead = true
    setState('dead', '假人死亡')
    bot.pathfinder.setGoal(null)
    // mineflayer 默认自动重生（options.respawn = true）
  })

  bot.on('respawn', async () => {
    // 本服传送插件（warp/back 的“3 秒后传送”）会在传送时发送 respawn 数据包（伪重生），
    // 此时并未真正死亡（未触发 death 事件，botDead 仍为 false）。
    // 若在这里盲目 /back 会再次触发传送→伪重生→/back 死循环，因此只有真死后才 /back。
    if (!botDead) {
      log('收到重生数据包但未死亡（疑似 warp 传送触发），忽略，不执行 /back')
      return
    }
    botDead = false
    log('已重生，输入 /back')
    await sleep(1000)
    for (let i = 0; i < 3; i++) {
      teleportAck = false
      bot.chat('/back')
      if (await waitTeleportDone(DEPOSIT_WAIT_MS + 2000)) break
      log('未收到“传送完成”提示，重试 /back')
    }
    setState('hunt', '重生返回')
    log(`返回原位置 ${bot.entity.position.floored ? bot.entity.position.floored() : bot.entity.position}，继续执行`)
  })

  bot.on('path_update', r => {
    currentPath = r.path || []
    lastPathStatus = r.status
    if (r.status === 'noPath') {
      noPathCount++
      if (noPathCount > 5) noPathFlag = true
      log(`[路径] 无法到达目标（noPath）${lastGoalDesc ? '，目标: ' + lastGoalDesc : ''}（累计 ${noPathCount} 次）`)
    } else if (r.status === 'success') {
      noPathCount = 0
      noPathFlag = false
      log(`[路径] 规划完成：${currentPath.length} 个节点，代价 ${(r.cost || 0).toFixed(1)}，耗时 ${r.time}ms`)
    } else if (r.status === 'partial' || r.status === 'timeout') {
      noPathCount = 0
      noPathFlag = false
      log(`[路径] 计算${r.status === 'timeout' ? '超时' : '部分'}：暂用 ${currentPath.length} 个节点`)
    }
  })
  bot.on('path_reset', reason => log(`[路径] 路径重置：${reason}${lastGoalDesc ? '（目标: ' + lastGoalDesc + '）' : ''}`))
  bot.on('goal_reached', () => log(`[路径] 已到达目标${lastGoalDesc ? '：' + lastGoalDesc : ''}`))

  bot.on('kicked', reason => {
    log('被踢出服务器:', typeof reason === 'string' ? reason : JSON.stringify(reason))
    if (!intentionalQuit) scheduleReconnect()
  })
  bot.on('error', err => log('连接错误:', err.message))
  bot.on('end', reason => {
    log('连接断开:', reason)
    if (!intentionalQuit) scheduleReconnect()
  })

  // ---- 网页监控：聊天 - 查看其他玩家聊天 + 系统消息 ----
  bot.on('chat', (username, message) => {
    const c = { username, message, t: Date.now() }
    chatBuffer.push(c)
    if (chatBuffer.length > 100) chatBuffer.shift()
    webBroadcast({ type: 'chat', username, message })
  })
  bot.on('messagestr', (text) => {
    if (/^<[^>]+>/.test(text)) return // 玩家聊天已由 chat 事件处理，避免重复
    if (text.includes('传送完成')) teleportAck = true // 系统“传送完成”提示（部分匹配）
    log('[系统]', text) // 系统消息也写入日志，便于排查（如死亡提示）
    webBroadcast({ type: 'sys', text })
  })
}

// ---------------- 主循环 ----------------
async function mainLoop () {
  try {
    while (running && !paused) {
      try {
        if (intentionalQuit) return
        if (botDead || state !== 'hunt') { await sleep(500); continue }

      // 1) 进食（最高优先级）
      if (await tryEat()) continue

      // 2) 物品栏已满 → 仓库流程
      if (inventoryFull()) {
        log('物品栏已满，进入仓库流程')
        await depositFlow()
        continue
      }

      // 3) 寻找目标（mooshroom 优先，其次 cow，取最近）
      const target = findTarget()
      if (!target) { await sleep(1000); continue }

      log(`找到目标: ${target.name} @ ${target.position.floored ? target.position.floored() : target.position}，距离 ${bot.entity.position.distanceTo(target.position).toFixed(1)} 格`)
      await attackUntilDead(target)

      // 4) 拾取掉落物（物品栏已满则跳过，直接去存仓）
      if (inventoryFull()) {
        log('物品栏已满，跳过拾取')
      } else {
        await collectDrops()
      }
      } catch (err) {
        log('主循环异常:', err && err.stack || err)
        await sleep(1000)
      }
    }
  } finally {
    mainLoopActive = false
  }
}

// ---------------- 攻击 ----------------
async function attackUntilDead (target) {
  ensureSword()
  noPathCount = 0
  noPathFlag = false
  const targetId = target.id
  let lastAttack = 0
  const where = target.position.floored ? target.position.floored() : target.position
  startPath(new GoalFollow(target, STANDOFF), true, `攻击 ${target.name}@${where}`)

  while (running && !paused && state === 'hunt') {
    if (intentionalQuit || botDead || paused) return

    const cur = bot.entities[targetId]
    if (!cur || deadIds.has(targetId)) return                       // 目标死亡或消失
    if (bot.entity.position.distanceTo(cur.position) > TARGET_RADIUS + 10) return // 追太远，放弃
    if (noPathFlag) { log('无法寻路到目标，放弃该目标'); return }

    // 攻击间隙进食
    if (await tryEat()) {
      const again = bot.entities[targetId]
      if (again) startPath(new GoalFollow(again, STANDOFF), true, `继续攻击 ${again.name}@${again.position.floored ? again.position.floored() : again.position}`)
      continue
    }

    const d = bot.entity.position.distanceTo(cur.position)
    if (d <= ATTACK_RANGE && Date.now() - lastAttack >= ATTACK_INTERVAL) {
      bot.lookAt(cur.position.offset(0, cur.height / 2, 0)).catch(() => {})
      bot.attack(cur)
      lastAttack = Date.now()
      myKills.set(targetId, lastAttack) // 记录攻击时间，用于击杀归属判定
      log(`[攻击] ${cur.name} 命中（距离 ${d.toFixed(1)} 格）`)
    }
    await sleep(250)
  }
  bot.pathfinder.setGoal(null)
}

// ---------------- 拾取掉落物 ----------------
async function collectDrops () {
  // 死亡瞬间扫描：目标死亡位置 2 格内的物品实体都判定为掉落物（兼容事件到达顺序）
  pruneRecentDeaths()
  for (const e of Object.values(bot.entities)) {
    if (e.name !== 'item' || !e.position) continue
    for (const d of recentDeaths) {
      if (d.pos.distanceTo(e.position) < DROP_RADIUS) { dropIds.add(e.id); break }
    }
  }

  const giveUpAt = Date.now() + DROP_WINDOW_MS * 3 // 单个目标最多拾取 9 秒
  while (running && !paused && state === 'hunt' && Date.now() < giveUpAt) {
    if (botDead || intentionalQuit || paused) return
    if (inventoryFull()) return // 满了就停，交给存仓流程

    const items = [...dropIds].map(id => bot.entities[id]).filter(e => e && e.name === 'item' && e.position)
    if (!items.length) break
    items.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
    const it = items[0]
    const itemName = itemEntityName(it)
    log(`[掉落] 拾取${itemName ? ' ' + itemName : ''} @ ${it.position.floored ? it.position.floored() : it.position}`)
    startPath(new GoalNear(it.position.x, it.position.y, it.position.z, 1), false, `拾取掉落物@${it.position.floored ? it.position.floored() : it.position}`)

    const start = Date.now()
    while (Date.now() - start < 3000) {
      if (!bot.entities[it.id]) { // 已被拾取
        log(`[掉落] 已拾取${itemName ? ' ' + itemName : ''}，继续下一个`)
        break
      }
      await sleep(200)
    }
  }
  bot.pathfinder.setGoal(null)
  for (const id of [...dropIds]) if (!bot.entities[id]) dropIds.delete(id)
}

// ---------------- 进食 ----------------
async function tryEat () {
  if (Date.now() - lastEatTime < EAT_COOLDOWN_MS) return false
  const needEat = (bot.health < 12 && bot.foodSaturation <= 19) || bot.food < 16
  if (!needEat) return false

  const prevState = state
  setState('eat', '生命/饱食不足')

  const off = bot.inventory.slots[45]
  let pork = bot.inventory.items().find(i => i && i.name === PORKCHOP)
  if (!pork && off && off.name === PORKCHOP) pork = off

  if (!pork) {
    log('所有熟猪肉已耗尽，下线')
    intentionalQuit = true
    bot.quit('熟猪肉耗尽')
    return true
  }

  // 仅当副手没有熟猪肉时才手动放入副手
  if (!off || off.name !== PORKCHOP) {
    await putInOffhand(pork)
  }

  // 停止移动，开始食用
  bot.pathfinder.setGoal(null)
  const offNow = bot.inventory.slots[45]
  const beforeCount = offNow ? offNow.count : 0
  bot.activateItem(true)
  log(`开始食用熟猪肉（副手 ${beforeCount} 个）`)
  const start = Date.now()
  while (Date.now() - start < 8000) {
    if (botDead) break
    const s = bot.inventory.slots[45]
    const c = s ? s.count : 0
    if (c < beforeCount) break // 数量减少 = 食用动作完成
    await sleep(250)
  }
  try { bot.deactivateItem() } catch {}
  lastEatTime = Date.now()
  log('食用完成')
  if (!botDead) setState(prevState, '进食完成')
  return true
}

/** 手动把熟猪肉放到副手（玩家窗口槽位：主物品栏 9-35、快捷栏 36-44、副手 45） */
async function putInOffhand (pork) {
  // 进食只在狩猎阶段发生，正常无容器窗口；若意外有则先关掉，避免点错槽位
  if (bot.currentWindow && bot.currentWindow.id !== 0) {
    try { bot.closeWindow(bot.currentWindow) } catch {}
    await sleep(200)
  }
  const srcSlot = pork.slot // 玩家窗口槽位（物品来自 bot.inventory.items()）
  const offSlot = 45        // 副手槽
  const offItem = bot.inventory.slots[offSlot]
  log(`将熟猪肉放入副手（源槽 ${srcSlot} → 副手槽 ${offSlot}）`)
  bot.clickWindow(srcSlot, 0, 0)
  await sleep(200)
  bot.clickWindow(offSlot, 0, 0)
  await sleep(200)
  if (offItem && offItem.name !== PORKCHOP) { // 原副手物品放回源槽
    bot.clickWindow(srcSlot, 0, 0)
    await sleep(200)
  }
}

// ---------------- 仓库流程 ----------------
async function depositFlow () {
  setState('deposit', '物品栏已满')
  bot.pathfinder.setGoal(null)

  // 阶段1: 先寻路到“周围 5 格都没有目标”的安全位置，再 /home cangku；
  // 以系统聊天出现“传送完成”判定传送成功（部分匹配），未收到则重试
  await goToSafeSpot()
  let teleported = false
  for (let attempt = 0; attempt < 30 && !teleported; attempt++) {
    if (botDead || intentionalQuit || paused) return
    if (!isPositionSafe(bot.entity.position)) { // 等待/重试期间目标可能追过来
      log('传送位置已不安全，重新寻路')
      await goToSafeSpot()
      if (botDead || intentionalQuit || paused) return
    }
    teleportAck = false
    bot.chat('/home cangku')
    log(`输入 /home cangku（第 ${attempt + 1} 次）`)
    await waitDefensive(DEPOSIT_WAIT_MS)
    if (state !== 'deposit') return // 期间死亡等中断
    if (!teleportAck) await waitTeleportDone(2000) // 传送偶尔略慢，再等 2 秒
    if (teleportAck) { teleported = true; break }
    log('未收到“传送完成”提示，重试 /home cangku')
  }
  if (!teleported) { log('多次输入 /home cangku 均未传送，稍后重试'); setState('hunt', '传送失败重试'); return }

  // 阶段2: 寻找 barrel 并打开
  let win = await openBarrel()
  if (!win || state !== 'deposit') { log('未找到 barrel 或流程中断'); setState('hunt', '存仓中断'); return }

  // 阶段3: 将背包中除盔甲/剑/熟猪肉外的所有物品移入容器，限速 4 次/秒
  dropIds.clear() // 存仓期间不拾取掉落物
  let fullSince = null
  let lastOp = 0
  while (state === 'deposit') {
    if (botDead || intentionalQuit || paused) return
    const item = nextDepositItem(win)
    if (!item) break

    // 窗口被关闭则重新打开
    let w = bot.currentWindow
    if (!w || w.id !== win.id) {
      log('容器窗口已关闭，重新打开')
      const w2 = await openBarrel()
      if (!w2) return
      win = w2
      w = win
      fullSince = null
    }

    // 容器已满：每秒查看一次空位，10 秒后仍无空位则待机，每 10 秒检查一次
    if (!containerHasSpace(w)) {
      if (fullSince === null) { fullSince = Date.now(); log('容器已满，等待空位') }
      if (Date.now() - fullSince > 10000) {
        log('容器已满超过 10 秒，待机（每 10 秒检查一次）')
        await sleep(10000)
      } else {
        await sleep(1000)
      }
      continue
    }
    fullSince = null

    // 限速：两次操作间隔 ≥300ms（一秒最多 4 次）
    const gap = CONTAINER_OP_INTERVAL - (Date.now() - lastOp)
    if (gap > 0) await sleep(gap)
    try {
      bot.clickWindow(item.slot, 0, 1) // item.slot 即容器窗口槽位；shift-click 整组移入容器
      lastOp = Date.now()
      log(`移入容器: ${item.name} x${item.count}`)
    } catch (err) {
      log('移动物品失败:', err.message)
    }
    await sleep(150) // 等待服务器处理该次点击
  }

  log('所有物品已放入容器')
  try { bot.closeWindow(bot.currentWindow) } catch {}
  await sleep(300)

  // 阶段4: /back，以系统“传送完成”提示为准，超时重试
  for (let i = 0; i < 3; i++) {
    teleportAck = false
    bot.chat('/back')
    log('已输入 /back')
    if (await waitTeleportDone(DEPOSIT_WAIT_MS + 2000)) break
    log('未收到“传送完成”提示，重试 /back')
  }
  setState('hunt', '存仓完成')
  log('返回工作点，继续流程')
}

function waitForWindowOpen (timeout) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { bot.removeListener('windowOpen', onEv); resolve(null) }, timeout)
    function onEv (w) { clearTimeout(timer); resolve(w) }
    bot.once('windowOpen', onEv)
  })
}

/**
 * 通过 /warp 菜单传送到工作点：
 * 1) 发送 /warp（服务器弹出箱子菜单）
 * 2) 等待箱子界面打开
 * 3) 拿起第一行第二个物品（槽位 1，左键点击触发传送）
 * 4) 以系统聊天出现“传送完成”判定传送成功（部分匹配），未收到则重试直到成功
 */
async function warpToWork () {
  for (let attempt = 1; ; attempt++) {
    if (botDead || intentionalQuit) return false
    bot.chat('/warp')
    log(`已发送 /warp（第 ${attempt} 次）`)

    // 等待箱子界面（warp 菜单）打开
    const win = await waitForWindowOpen(6000)
    if (!win || win.id === 0) {
      log('warp 菜单未打开，2 秒后重试')
      await sleep(2000)
      continue
    }
    const slotItem = win.slots[1]
    log(`warp 菜单已打开（${win.title || '未知标题'}），拿起第一行第二个物品${slotItem ? '：' + slotItem.name : ''}`)
    // 点击前重置传送完成标记，点击后以系统聊天出现“传送完成”判定成功（部分匹配）
    teleportAck = false
    try {
      bot.clickWindow(1, 0, 0) // 左键拿起第一行第二个物品，触发传送
      await sleep(600)
    } catch (err) {
      log('点击 warp 菜单失败:', err.message)
    }
    try { bot.closeWindow(bot.currentWindow) } catch {}

    // 等 3.5s 传送生效（传送插件会先提示“3 秒后被传送”），未收到提示再等 2 秒
    if (await waitTeleportDone(DEPOSIT_WAIT_MS + 2000)) {
      log('warp 传送完成')
      return true
    }
    log('warp 传送未生效（未收到“传送完成”提示），2 秒后重试')
    await sleep(2000)
  }
}

async function openBarrel () {
  for (let i = 0; i < 15; i++) {
    if (state !== 'deposit' || botDead) return null
    // 关闭可能残留的窗口，避免重复打开被服务器拒绝
    if (bot.currentWindow) {
      try { bot.closeWindow(bot.currentWindow) } catch {}
      await sleep(200)
    }
    const barrel = bot.findBlock({ matching: b => b.name === 'barrel', maxDistance: 10 })
    if (barrel) {
      try {
        bot.lookAt(barrel.position.offset(0.5, 0.5, 0.5)).catch(() => {})
        await sleep(200)
        bot.activateBlock(barrel)
        const w = await waitForWindowOpen(3000) // 等待容器界面打开，3 秒超时
        if (w) { log('已打开 barrel 窗口'); return w }
        log('打开 barrel 窗口超时，重试')
      } catch (err) {
        log('打开 barrel 失败:', err.message)
      }
    } else {
      log('10 格内未找到 barrel')
    }
    await sleep(1000)
  }
  return null
}

/** 等待阶段：不移动、不拾取掉落物；附近有目标则原地切剑攻击 */
async function waitDefensive (ms) {
  ensureSword()
  let lastAttack = 0
  const end = Date.now() + ms
  while (Date.now() < end && running && !paused) {
    if (state !== 'deposit' || botDead) return
    if (Date.now() - lastAttack >= 1000) {
      const t = findTargetInRange(ATTACK_RANGE + 0.3)
      if (t) {
        bot.lookAt(t.position.offset(0, t.height / 2, 0)).catch(() => {})
        bot.attack(t)
        lastAttack = Date.now()
        myKills.set(t.id, lastAttack)
        log(`[攻击] ${t.name} 命中（防御性，等待传送）`)
      }
    }
    await sleep(200)
  }
}

/** 等待系统聊天出现“传送完成”提示（部分匹配），超时返回 false */
async function waitTeleportDone (timeoutMs) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (teleportAck) return true
    if (botDead || intentionalQuit) return false
    await sleep(200)
  }
  return teleportAck
}

/** 判断某位置周围 5 格内是否有目标（mooshroom/cow） */
function isPositionSafe (pos) {
  for (const e of Object.values(bot.entities)) {
    if (!isTargetEntity(e) || deadIds.has(e.id)) continue
    if (pos.distanceTo(e.position) <= 5) return false
  }
  return true
}

/** 在机器人周围螺旋搜索一个“周围 5 格无目标”的可站立位置，找不到返回 null */
function findSafeSpot () {
  const base = bot.entity.position.floored()
  for (let r = 1; r <= 24; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue // 只取半径为 r 的环
        const pos = base.offset(dx, 0, dz)
        const at = bot.blockAt(pos)
        const below = bot.blockAt(pos.offset(0, -1, 0))
        if (!at || !below) continue
        if (at.boundingBox === 'block') continue // 站立方块必须非实心
        if (at.name === 'water' || at.name === 'lava' || at.name === 'flowing_water' || at.name === 'flowing_lava') continue
        if (below.boundingBox !== 'block') continue // 脚下必须是实心方块
        const stand = pos.offset(0.5, 0, 0.5)
        if (!isPositionSafe(stand)) continue
        return stand
      }
    }
  }
  return null
}

/**
 * 卸货前寻路到“周围 5 格都没有目标”的安全位置，再执行传送命令。
 * 到达后目标可能追过来，若仍不安全则重新寻找；多次尝试后仍不行则就地传送。
 */
async function goToSafeSpot () {
  if (isPositionSafe(bot.entity.position)) return // 当前位置已安全，无需移动
  for (let attempt = 0; attempt < 10; attempt++) {
    if (botDead || intentionalQuit || paused) return
    const spot = findSafeSpot()
    if (!spot) {
      log('未找到安全位置，原地等待 3 秒后重试')
      await sleep(3000)
      if (isPositionSafe(bot.entity.position)) return
      continue
    }
    log(`寻路到安全位置 ${spot.floored()}（周围 5 格无目标）`)
    startPath(new GoalNear(spot.x, spot.y, spot.z, 1), false, `安全位置@${spot.floored()}`)
    const start = Date.now()
    while (Date.now() - start < 15000) {
      if (botDead || intentionalQuit || paused) return
      await sleep(500)
      if (bot.entity.position.distanceTo(spot) <= 2) break // 已到达
      if (!bot.pathfinder.isMoving()) { log('无法寻路到该位置，换位置重试'); break }
    }
    bot.pathfinder.setGoal(null)
    if (botDead || intentionalQuit || paused) return
    if (isPositionSafe(bot.entity.position)) return // 到达且安全
    log('到达后仍有目标在 5 格内，重新寻找安全位置')
  }
  log('未能到达安全位置，就地执行传送')
}

// ---------------- 重连 ----------------
let reconnectTimer = null
function scheduleReconnect () {
  if (reconnectTimer || intentionalQuit) return
  log('5 秒后重新连接...')
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (intentionalQuit) return
    running = false
    createBot()
  }, 5000)
}

// ---------------- 底层兼容补丁 ----------------
/**
 * 1.21.2+ tick 同步补丁（重要！假人“无法移动”的关键修复）
 * 原版客户端：每 tick 发送 client_tick_end（约 20 次/秒）；世界加载完成后发送一次 player_loaded。
 * 服务器（尤其带反作弊/挂机检测的服，如本服高频 common_ping 探测）会据此验证客户端与服务器
 * tick 同步；mineflayer 默认不发这两个包 → 服务器判定客户端失步 → 静默无视所有移动包
 * （表现为：原版端能移动，假人无论怎么发包都纹丝不动）。这里补齐。
 */
function enableTickSync (bot) {
  if (!bot || !bot._client) return
  // 每 tick 发送 client_tick_end（进入游戏后 physicTick 每 50ms 触发一次）
  bot.on('physicTick', () => {
    try { bot._client.write('tick_end', {}) } catch {}
  })
  // 世界加载完成后发送一次 player_loaded（spawn/重生/传送后均可能触发世界加载）
  const sendPlayerLoaded = () => {
    setTimeout(() => {
      try {
        bot._client.write('player_loaded', {})
        log('[登录] 已发送 player_loaded（客户端加载完成）')
      } catch {}
    }, 3000)
  }
  bot.on('spawn', sendPlayerLoaded)
  bot.on('respawn', sendPlayerLoaded)
  
  // 增加移动包发送频率：每 50ms 发送一次位置更新（原版客户端约 20 次/秒）
  let lastMoveTime = 0
  bot.on('physicTick', () => {
    const now = Date.now()
    if (now - lastMoveTime >= 50) { // 20 次/秒
      try {
        if (bot.entity) {
          bot._client.write('position', {
            x: bot.entity.position.x,
            y: bot.entity.position.y,
            z: bot.entity.position.z,
            yaw: bot.entity.yaw,
            pitch: bot.entity.pitch,
            onGround: true
          })
        }
      } catch {}
      lastMoveTime = now
    }
  })
}
// 1) mineflayer 4.30+ 的 bot.chat 内部调用 bot._client.chat(message)，
//    而该方法是 minecraft-protocol 在登录（onReady）后才赋值的；
//    若连接卡在登录前或上游版本不赋值，就会抛 "bot._client.chat is not a function"。
//    这里在创建客户端后立即补一个用原生数据包实现的兜底（登录后会被真正的实现覆盖）。
function ensureClientChat (client) {
  if (!client || typeof client.chat === 'function') return
  client.chat = (message) => {
    const ts = BigInt(Date.now())
    if (typeof message === 'number') message = message.toString()
    if (message.startsWith('/')) {
      client.write('chat_command', {
        command: message.slice(1),
        timestamp: ts,
        salt: 1n,
        argumentSignatures: [],
        messageCount: 0,
        checksum: Buffer.alloc(8),
        acknowledged: Buffer.alloc(3)
      })
    } else {
      client.write('chat_message', {
        message,
        timestamp: ts,
        salt: 1n,
        signature: undefined,
        offset: 0,
        checksum: Buffer.alloc(8),
        acknowledged: Buffer.alloc(3)
      })
    }
  }
  
  // 2) 增强移动包发送：确保每 50ms 发送一次位置更新，即使没有移动
  function enhanceMovementPackets (client) {
    if (!client || !client.write) return
    const originalWrite = client.write
    client.write = (name, params) => {
      if (name === 'position' || name === 'position_look') {
        // 确保位置更新包包含正确的 onGround 状态
        params.onGround = true
        if (params.flags) params.flags.onGround = true
      }
      return originalWrite.call(client, name, params)
    }
    
    // 每 50ms 发送一次位置更新（增强版，确保移动包频率）
    let lastPosUpdate = 0
    client.on('tick', () => {
      const now = Date.now()
      if (now - lastPosUpdate >= 50) { // 20 次/秒
        try {
          if (client.bot && client.bot.entity) {
            client.write('position', {
              x: client.bot.entity.position.x,
              y: client.bot.entity.position.y,
              z: client.bot.entity.position.z,
              yaw: client.bot.entity.yaw,
              pitch: client.bot.entity.pitch,
              onGround: true
            })
          }
        } catch {}
        lastPosUpdate = now
      }
    })
  }
  
  enhanceMovementPackets(client)
}

// 2) 服务器在配置阶段下发 add_resource_pack（强制资源包）时会等客户端回包后才发
//    finish_configuration，不回包就永远进不了游戏（表现为登录失败/超时断线）。
//    mineflayer 自带的 acceptResourcePack 有上游 bug（PR #3842 未合并）：把 uuid-1345
//    对象直接写回，protodef 会序列化成 16 个 0 字节，服务器匹配不上 UUID 从而忽略响应。
//    这里直接用字符串 UUID 回包（ACCEPTED=3，SUCCESSFULLY_LOADED=0）。
function autoAcceptResourcePack (client) {
  if (!client || typeof client.on !== 'function') return
  const reply = (uuid, result) => {
    try { client.write('resource_pack_receive', { uuid, result }) } catch {}
  }
  const accept = (data) => {
    const uuid = typeof data.uuid === 'string' ? data.uuid : String(data.uuid)
    log('收到服务器资源包，自动接受')
    reply(uuid, 3) // ACCEPTED
    reply(uuid, 0) // SUCCESSFULLY_LOADED
  }
  client.on('add_resource_pack', accept)
  client.on('resource_pack_send', accept)
}

// ---------------- 创建 bot ----------------
function createBot () {
  log(`[启动] 连接 ${HOST}:${PORT}（用户名 ${BOT_USERNAME}，版本 ${VERSION}，auth ${AUTH}${AUTO_START ? '，自动开始' : '，待机模式'}）`)
  bot = mineflayer.createBot({ host: HOST, port: PORT, username: BOT_USERNAME, version: VERSION, auth: AUTH })
  ensureClientChat(bot._client)
  autoAcceptResourcePack(bot._client)
  bot.loadPlugin(pathfinder)
  enableTickSync(bot)
  // mineflayer 4.20+ 的 loadPlugin 只排队插件，连接成功（inject_allowed）后才注入，
  // 因此 bot.pathfinder 此时尚不存在，需等注入后再设置寻路参数
  bot.once('inject_allowed', () => {
    const movements = new CustomMovements(bot)
    if (NO_SPRINT) {
      movements.allowSprinting = false
      log('[移动] NO_SPRINT=1：已禁用疾跑（仅普通行走）')
    }
    bot.pathfinder.setMovements(movements)
    if (FORCE_ON_GROUND) {
      // 拦截所有移动包，强制 onGround=true（mineflayer 在非整方块上站立时
      // onGround 会闪烁 false，部分反作弊会判“飞行”冻结，原版客户端恒为 true）
      const rawWrite = bot._client.write.bind(bot._client)
      bot._client.write = (name, params) => {
        if (name === 'position' || name === 'look' || name === 'position_look') {
          params.onGround = true
          if (params.flags) params.flags.onGround = true
        }
        return rawWrite(name, params)
      }
      log('[移动] FORCE_ON_GROUND=1：移动包强制 onGround=true')
    }
  })
  registerEvents()
  // 网页 3D 视图绑定（重连时重建）：attachBot 是 viewerServer 模块级函数，
  // 会关闭旧视图服务器并在同端口用新 bot 重建
  if (viewerServer) viewerCtl = viewerServer.attachBot(bot, VIEWER_PORT)
  return bot
}

createBot()

// ---------------- 网页监控 ----------------
function startWeb () {
  try {
    const monitor = require('./web/monitor')
    webApi = monitor.startMonitor({
      getBot: () => bot,
      getStatus,
      getLogs: () => logBuffer,
      getChats: () => chatBuffer,
      setPaused,
      getPaused: () => paused,
      getConfig: () => ({ username: BOT_USERNAME, version: VERSION, webPort: WEB_PORT, viewerPort: VIEWER_PORT, autoStart: AUTO_START }),
      getViewerControl: () => viewerCtl
    })
  } catch (err) {
    console.error('[web] 监控启动失败:', err.message)
  }
  try {
    viewerServer = require('./web/viewerServer')
    viewerCtl = viewerServer.attachBot(bot, VIEWER_PORT)
  } catch (err) {
    console.error('[web] 3D 视图启动失败:', err.message)
  }
}
startWeb()

// ---------------- 进程兜底 ----------------
process.on('uncaughtException', err => log('未捕获异常:', err && err.stack || err))
process.on('unhandledRejection', err => log('未处理的 Promise 拒绝:', err && err.stack || err))
process.on('SIGINT', () => {
  intentionalQuit = true
  if (bot) bot.quit('手动退出')
  setTimeout(() => process.exit(0), 500)
})
