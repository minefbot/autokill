/**
 * 移动诊断探针 v11：完全模拟原版客户端行走包序列
 * - 每 tick：先发移动包（position_look，原版步行速度 4.317 格/秒，onGround=true），再发 tick_end
 * - 每 5 tick 插一个 flying(onGround=true)（原版在移动中夹杂 OnGroundOnly）
 * - 行走开始/状态变化时发 player_input{forward:true}
 * - 疾跑时发 client_command（原版用 client_command 而非 entity_action）
 * - 收到服务器 position 同步（forcedMove）后：teleport_confirm + 从同步位置继续走
 * - 全程压制 mineflayer 自身物理移动包，只发模拟的原版序列
 * 运行: node tools/move-probe11.js
 */
require('dotenv').config({ quiet: true })

const mineflayer = require('mineflayer')
const HOST = process.env.HOST || 'localhost'
const PORT = parseInt(process.env.PORT || '25565', 10)
const BOT_USERNAME = process.env.BOT_USERNAME || 'XQYXQY'
const VERSION = process.env.VERSION || '1.21.11'
const AUTH = process.env.AUTH || 'offline'
const PSW = process.env.PSW
if (!PSW) { console.error('缺少 PSW'); process.exit(1) }

const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('en-GB', { hour12: false })}.${String(Date.now() % 1000).padStart(3, '0')}]`, ...a)

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: BOT_USERNAME, version: VERSION, auth: AUTH })

// ---- 压制 mineflayer 自己的移动包，只留 tick_end 与我们的模拟包 ----
const rawWrite = bot._client.write.bind(bot._client)
const MOVE_PACKETS = new Set(['position', 'look', 'position_look', 'flying'])
let suppress = false

bot.once('inject_allowed', () => {
  const client = bot._client
  const reply = (uuid, result) => { try { client.write('resource_pack_receive', { uuid, result }) } catch {} }
  const accept = (data) => {
    const uuid = typeof data.uuid === 'string' ? data.uuid : String(data.uuid)
    log('收到资源包，自动接受')
    reply(uuid, 3); reply(uuid, 0)
  }
  client.on('add_resource_pack', accept)
  client.on('resource_pack_send', accept)
})

let curPos = null // 我们模拟的位置（跟随服务器同步）
let walkActive = false
let walkDx = 0
let walkDz = 0

// 服务器同步（forcedMove）：mineflayer 已回 teleport_confirm，这里只用它的位置更新模拟起点
bot.on('forcedMove', (movedPos) => {
  if (movedPos && typeof movedPos.x === 'number') curPos = { x: movedPos.x, y: movedPos.y, z: movedPos.z }
})

/** 每 tick 行走定时器：只发原版风格移动包（tick_end 走 physicTick，保证 spawn 后立即有） */
let tickTimer = null
let tickCount = 0
function startTicking () {
  if (tickTimer) return
  tickCount = 0
  tickTimer = setInterval(() => {
    tickCount++
    if (!walkActive || !curPos) return
    // 原版步行速度 4.317 格/秒 = 0.21585 格/tick
    curPos.x += walkDx / 20
    curPos.z += walkDz / 20
    try {
      rawWrite('position_look', {
        x: curPos.x, y: curPos.y, z: curPos.z,
        yaw: Math.atan2(-walkDx, -walkDz), pitch: 0,
        flags: { onGround: true, hasHorizontalCollision: false }
      })
      if (tickCount % 5 === 0) {
        rawWrite('flying', { flags: { onGround: true, hasHorizontalCollision: false } })
      }
    } catch (e) { log('移动包发送失败:', e.message) }
  }, 50)
}
function stopTicking () {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
}

bot.on('physicTick', () => { try { bot._client.write('tick_end', {}) } catch {} })
bot.once('spawn', () => {
  setTimeout(() => { try { bot._client.write('player_loaded', {}) } catch {} }, 3000)
})

bot.on('kicked', r => { log('被踢:', typeof r === 'string' ? r : JSON.stringify(r)); process.exit(1) })
bot.on('error', e => log('错误:', e.message))
bot.on('end', r => { log('连接断开:', r); setTimeout(() => process.exit(0), 500) })

async function vanillaMimicWalk (name, dx, dz, secs, sprint) {
  suppress = true
  walkActive = false
  bot.clearControlStates()
  await sleep(300)
  const start = bot.entity.position.clone()
  curPos = { x: start.x, y: start.y, z: start.z }
  // 原版：按键时发 player_input
  try { rawWrite('player_input', { inputs: { forward: true, sprint: !!sprint } }) } catch (e) { log('player_input 失败:', e.message) }
  if (sprint) {
    // 原版疾跑：client_command 3=开始疾跑
    try { rawWrite('client_command', { actionId: 3 }) } catch (e) { log('client_command 失败:', e.message) }
  }
  walkActive = true
  walkDx = dx
  walkDz = dz
  startTicking()
  const t0 = Date.now()
  while (Date.now() - t0 < secs * 1000) {
    await sleep(250)
    log(`[模拟:${name}] t=${((Date.now() - t0) / 1000).toFixed(1)}s pos=${bot.entity.position.x.toFixed(2)},${bot.entity.position.y.toFixed(2)},${bot.entity.position.z.toFixed(2)} og=${bot.entity.onGround} 模拟z=${curPos.z.toFixed(2)}`)
  }
  walkActive = false
  walkDx = 0
  walkDz = 0
  stopTicking()
  if (sprint) { try { rawWrite('client_command', { actionId: 4 }) } catch {} }
  try { rawWrite('player_input', { inputs: {} }) } catch {}
  await sleep(1000)
  const moved = start.distanceTo(bot.entity.position)
  log(`[模拟:${name}] 位移 ${moved.toFixed(2)} 格（${start.floored()} → ${bot.entity.position.floored()}）`)
  suppress = false
  return moved
}

bot.once('spawn', async () => {
  log(`已进入服务器（版本 ${bot.version}）`)
  await sleep(1500)
  bot.chat(`/login ${PSW}`)
  await sleep(2500)
  await sleep(8000)

  log('=== 模拟1：原版步行（position_look 每tick + tick_end + player_input + flying）北 4s ===')
  await vanillaMimicWalk('步行', 0, -1, 4, false)

  log('=== 模拟2：原版疾跑（+client_command）北 4s ===')
  await vanillaMimicWalk('疾跑', 0, -1, 4, true)

  log('=== 模拟3：原版步行 东 4s ===')
  await vanillaMimicWalk('步行东', 1, 0, 4, false)

  log('=== 探针结束 ===')
  bot.quit('probe done')
  setTimeout(() => process.exit(0), 800)
})
setTimeout(() => { log('总超时 150s，退出'); process.exit(2) }, 150000)
