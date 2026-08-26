/**
 * 移动诊断探针 v13：重复会话 / 跳跃 / 实体扫描
 * - 打印 bot.players（在线玩家）与 20 格内玩家实体
 * - 跳跃测试：y 是否变化（垂直移动是否被允许）
 * - 前进测试：完整 S2C position 日志
 * 运行: node tools/move-probe13.js
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

bot.once('inject_allowed', () => {
  const client = bot._client
  const reply = (uuid, result) => { try { client.write('resource_pack_receive', { uuid, result }) } catch {} }
  const accept = (data) => {
    const uuid = typeof data.uuid === 'string' ? data.uuid : String(data.uuid)
    log('收到资源包，自动接受'); reply(uuid, 3); reply(uuid, 0)
  }
  client.on('add_resource_pack', accept)
  client.on('resource_pack_send', accept)
})

bot.on('physicTick', () => { try { bot._client.write('tick_end', {}) } catch {} })
bot.on('spawn', () => { setTimeout(() => { try { bot._client.write('player_loaded', {}) } catch {} }, 3000) })
bot.on('kicked', r => { log('被踢:', typeof r === 'string' ? r : JSON.stringify(r)); process.exit(1) })
bot.on('error', e => log('错误:', e.message))
bot.on('end', r => { log('连接断开:', r); setTimeout(() => process.exit(0), 500) })
bot.on('messagestr', t => { t = t.trim(); if (t && !/^<|^\s*$/.test(t)) log('[聊天]', t.slice(0, 140)) })

bot.once('spawn', async () => {
  log(`已进入服务器（版本 ${bot.version}）`)
  await sleep(1500)
  bot.chat(`/login ${PSW}`)
  await sleep(2500)

  log('=== 在线玩家 ===')
  for (const [name, pl] of Object.entries(bot.players || {})) {
    log(`玩家 ${name} ping=${pl.ping} uuid=${pl.uuid} 实体=${!!pl.entity}`)
  }
  log('=== 20格内玩家实体 ===')
  for (const e of Object.values(bot.entities)) {
    if (e.type === 'player' && e !== bot.entity && e.position && e.position.distanceTo(bot.entity.position) < 20) {
      log(`实体 ${e.username} id=${e.id} pos=${e.position.floored()} 距=${e.position.distanceTo(bot.entity.position).toFixed(1)}`)
    }
  }

  log('=== 跳跃测试 2s ===')
  bot.setControlState('jump', true)
  let lastY = bot.entity.position.y
  for (let i = 0; i < 8; i++) {
    await sleep(250)
    const y = bot.entity.position.y
    log(`[跳] t=${i * 0.25}s y=${y.toFixed(3)} dy=${(y - lastY).toFixed(3)} og=${bot.entity.onGround}`)
    lastY = y
  }
  bot.clearControlStates()
  await sleep(500)

  log('=== 前进(W)测试 5s（面向南，看 S2C 反应） ===')
  bot.look(0, 0, true).catch(() => {})
  await sleep(400)
  const s = bot.entity.position.clone()
  bot.setControlState('forward', true)
  for (let i = 0; i < 10; i++) {
    await sleep(500)
    log(`[走] t=${i * 0.5}s pos=${bot.entity.position.x.toFixed(2)},${bot.entity.position.y.toFixed(2)},${bot.entity.position.z.toFixed(2)} og=${bot.entity.onGround}`)
  }
  bot.clearControlStates()
  await sleep(600)
  log(`[走] 位移 ${s.distanceTo(bot.entity.position).toFixed(2)} 格（${s.floored()} → ${bot.entity.position.floored()}）`)

  log('=== 原地 8s 观察服务器是否持续同步 ===')
  for (let i = 0; i < 8; i++) {
    await sleep(1000)
    log(`[待] t=${i}s pos=${bot.entity.position.x.toFixed(2)},${bot.entity.position.y.toFixed(2)},${bot.entity.position.z.toFixed(2)} og=${bot.entity.onGround}`)
  }

  log('=== 探针结束 ===')
  bot.quit('probe done')
  setTimeout(() => process.exit(0), 500)
})
setTimeout(() => { log('总超时 90s，退出'); process.exit(2) }, 90000)