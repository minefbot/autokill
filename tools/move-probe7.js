/**
 * 移动诊断探针 v7：A/B 对比 + 全量 C2S 抓包（对照原版抓包 packets-*.log）
 *
 * 目的：判断“移动极慢”是
 *  (a) bot 发的移动包频率不够（原版每 tick 都发，bot 可能 1s 才发一次），还是
 *  (b) 服务器对 mineflayer 物理/控制状态的移动做限速/拉回（rubber-band）。
 *
 * 流程（均在出生点，不 warp）：
 *   1. 登录 + tick 同步（tick_end/player_loaded，与 bot.js 一致）
 *   2. 全量记录 C2S 包： [HH:MM:SS.mmm] -> C2S PacketName（写入 probe-c2s.log，与原版抓包同格式）
 *   3. 测试A：控制状态行走（forward，3s）—— bot.js 现行方式
 *   4. 测试B：原始 position_look 每 tick 行走（20Hz、4.317 格/秒、onGround=true）—— 原版风格
 *   5. 测试C：原版风格 + 每 tick 交替发 flying(onGround-only) —— 完全模拟原版包序列
 *   每 250ms 采样位置；记录 forcedMove（服务器拉回）；统计每秒各包数量。
 *
 * 运行: node tools/move-probe7.js
 */
require('dotenv').config({ quiet: true })

const mineflayer = require('mineflayer')
const fs = require('fs')
const HOST = process.env.HOST || 'localhost'
const PORT = parseInt(process.env.PORT || '25565', 10)
const BOT_USERNAME = process.env.BOT_USERNAME || 'XQYXQY'
const VERSION = process.env.VERSION || '1.21.11'
const AUTH = process.env.AUTH || 'offline'
const PSW = process.env.PSW
if (!PSW) { console.error('缺少 PSW'); process.exit(1) }

const sleep = ms => new Promise(r => setTimeout(r, ms))
const now = () => new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0')
const log = (...a) => console.log(`[${now()}]`, ...a)

const c2sLog = fs.createWriteStream('probe-c2s.log', { flags: 'w' })
const c2sCount = {}          // 每秒各 C2S 包数量（用于打印汇总）
let c2sWindow = 0
let forcedMoveCount = 0
let suppressed = 0

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: BOT_USERNAME, version: VERSION, auth: AUTH })

// ---- 全量 C2S 记录（含 tick_end 等，原版抓包格式） ----
const rawWrite = bot._client.write.bind(bot._client)
const MOVE_PACKETS = new Set(['position', 'look', 'position_look', 'flying'])
let suppressMove = false
bot._client.write = (name, params) => {
  c2sLog.write(`[${now()}] -> C2S ${name}\n`)
  const sec = Math.floor(Date.now() / 1000)
  if (sec !== c2sWindow) { c2sWindow = sec; for (const k of Object.keys(c2sCount)) delete c2sCount[k] }
  c2sCount[name] = (c2sCount[name] || 0) + 1
  if (suppressMove && MOVE_PACKETS.has(name)) { suppressed++; return }
  return rawWrite(name, params)
}

// ---- 资源包自动接受（同 bot.js） ----
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

// ---- tick 同步（同 bot.js enableTickSync） ----
bot.on('physicTick', () => { try { bot._client.write('tick_end', {}) } catch {} })
bot.on('spawn', () => setTimeout(() => { try { bot._client.write('player_loaded', {}) } catch {} }, 3000))

// ---- 服务器拉回 / 位置纠正 ----
bot.on('forcedMove', (pos) => {
  forcedMoveCount++
  log(`[事件] forcedMove #${forcedMoveCount} @ ${pos ? pos.floored() : '?'}`)
})
bot.on('kicked', r => { log('被踢:', typeof r === 'string' ? r : JSON.stringify(r)); process.exit(1) })
bot.on('error', e => log('错误:', e.message))
bot.on('end', r => { log('连接断开:', r); setTimeout(() => process.exit(0), 500) })

function posStr () {
  const p = bot.entity ? bot.entity.position : null
  if (!p) return '?'
  return `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} onGround=${bot.entity.onGround}`
}

/** 测试A：mineflayer 控制状态行走 */
async function ctrlWalk (name, yaw, secs = 3) {
  bot.clearControlStates()
  await bot.look(yaw, 0, true).catch(() => {})
  await sleep(400)
  const s = bot.entity.position.clone()
  bot.setControlState('forward', true)
  const t0 = Date.now()
  while (Date.now() - t0 < secs * 1000) {
    await sleep(250)
    log(`[A:${name}] t=${((Date.now() - t0) / 1000).toFixed(1)}s pos=${posStr()}`)
  }
  bot.clearControlStates()
  await sleep(800)
  const moved = s.distanceTo(bot.entity.position)
  log(`[A:${name}] 位移 ${moved.toFixed(2)} 格（${s.floored()} → ${bot.entity.position.floored()}）`)
  return moved
}

/** 测试B/C：原版风格原始包行走（每 tick 一个 position_look，恒定 4.317 格/秒） */
async function rawWalk (name, yaw, dx, dz, secs = 3, interleaveFlying = false) {
  suppressMove = true
  const p = bot.entity.position
  const steps = secs * 20
  const per = { x: dx / secs / 20, z: dz / secs / 20 }
  let x = p.x, z = p.z
  const t0 = Date.now()
  let lastSample = 0
  for (let i = 0; i < steps; i++) {
    x += per.x; z += per.z
    try {
      rawWrite('position_look', {
        x, y: p.y, z,
        yaw: Math.atan2(-dx, -dz), pitch: 0,
        flags: { onGround: true, hasHorizontalCollision: false }
      })
      if (interleaveFlying) {
        rawWrite('flying', { flags: { onGround: true, hasHorizontalCollision: false } })
      }
    } catch (e) { log(`[raw] ${name}: 发送失败 ${e.message}`); break }
    if (Date.now() - lastSample >= 250) {
      lastSample = Date.now()
      log(`[B:${name}] t=${((Date.now() - t0) / 1000).toFixed(1)}s pos=${posStr()}`)
    }
    await sleep(50)
  }
  await sleep(1000)
  const moved = p.distanceTo(bot.entity.position)
  log(`[B:${name}] 发送 ${steps} 包，位移 ${moved.toFixed(2)} 格（${p.floored()} → ${bot.entity.position.floored()}）`)
  suppressMove = false
  return moved
}

bot.once('spawn', async () => {
  log(`已进入服务器（版本 ${bot.version}），等待登录与稳定`)
  await sleep(1500)
  bot.chat(`/login ${PSW}`)
  await sleep(2500)
  await sleep(8000) // 等 8 秒再动
  log(`当前位置: ${posStr()} 脚下=${bot.blockAt(bot.entity.position.offset(0, -1, 0)) && bot.blockAt(bot.entity.position.offset(0, -1, 0)).name}`)

  log('=== 测试A：控制状态行走 北 3s（bot.js 现行方式） ===')
  await ctrlWalk('北', Math.PI, 3)

  log('=== 测试B：原始每tick position_look 行走 北 3s ===')
  await rawWalk('北', Math.PI, 0, -1, 3, false)

  log('=== 测试C：原始行走 + 每tick交替flying 北 3s ===')
  await rawWalk('北', Math.PI, 0, -1, 3, true)

  log(`=== 探针结束：forcedMove=${forcedMoveCount}，被抑制的重复移动包=${suppressed} ===`)
  log('C2S 包统计（最近一秒）:', JSON.stringify(c2sCount))
  bot.quit('probe done')
  setTimeout(() => process.exit(0), 800)
})

setTimeout(() => { log('总超时 150s，退出'); process.exit(2) }, 150000)
