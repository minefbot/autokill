/**
 * 移动诊断探针 v9：记录 bot 发出的移动包【内容】（坐标/onGround）
 * 对照原版：原版站立时 y 恒定 76.0、onGround=true；怀疑 mineflayer 本地物理
 * 在服务器每 200ms 同步（onGround 被置 false、速度清零）后产生“下沉/onGround 闪烁”，
 * 导致反作弊判定异常而拒收移动。
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

const bothLog = fs.createWriteStream('probe9.log', { flags: 'w' })
const bot = mineflayer.createBot({ host: HOST, port: PORT, username: BOT_USERNAME, version: VERSION, auth: AUTH })

const rawWrite = bot._client.write.bind(bot._client)
const MOVES = new Set(['position', 'look', 'position_look', 'flying', 'teleport_confirm'])
bot._client.write = (name, params) => {
  if (MOVES.has(name)) {
    const p = params
    const yaw = p.yaw !== undefined ? p.yaw.toFixed(2) : '-'
    const pitch = p.pitch !== undefined ? p.pitch.toFixed(2) : '-'
    const og = p.flags ? p.flags.onGround : p.onGround
    const hc = p.flags ? p.flags.hasHorizontalCollision : '-'
    bothLog.write(`[${now()}] -> C2S ${name} x=${(p.x ?? '-').toString().slice(0, 12)} y=${(p.y ?? '-').toString().slice(0, 8)} z=${(p.z ?? '-').toString().slice(0, 12)} yaw=${yaw} pitch=${pitch} og=${og} hc=${hc}\n`)
  }
  return rawWrite(name, params)
}

// S2C position syncs
bot._client.on('packet', (data, meta) => {
  if (!meta || !meta.name || meta.name !== 'position') return
  const p = data.position || data.change || {}
  bothLog.write(`[${now()}] <- S2C position x=${(p.x ?? '').toString().slice(0, 12)} y=${p.y} z=${(p.z ?? '').toString().slice(0, 12)} tid=${data.teleportId} rel=${JSON.stringify(data.relatives || (data.flags && data.flags._value))}\n`)
})

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
bot.on('physicTick', () => { try { bot._client.write('tick_end', {}) } catch {} })
bot.on('spawn', () => setTimeout(() => { try { bot._client.write('player_loaded', {}) } catch {} }, 3000))

bot.on('kicked', r => { log('被踢:', typeof r === 'string' ? r : JSON.stringify(r)); process.exit(1) })
bot.on('error', e => log('错误:', e.message))
bot.on('end', r => { log('连接断开:', r); setTimeout(() => process.exit(0), 500) })

async function ctrlWalk (name, yaw, secs = 4) {
  bot.clearControlStates()
  await bot.look(yaw, 0, true).catch(() => {})
  await sleep(400)
  const s = bot.entity.position.clone()
  bot.setControlState('forward', true)
  await sleep(secs * 1000)
  bot.clearControlStates()
  await sleep(800)
  const moved = s.distanceTo(bot.entity.position)
  log(`[行走] ${name}: 位移 ${moved.toFixed(2)} 格（${s.floored()} → ${bot.entity.position.floored()}）`)
}

bot.once('spawn', async () => {
  log(`已进入服务器（版本 ${bot.version}）`)
  await sleep(1500)
  bot.chat(`/login ${PSW}`)
  await sleep(2500)
  await sleep(8000)
  log('=== 控制行走 北 4s（记录移动包内容） ===')
  await ctrlWalk('北', Math.PI, 4)
  log('=== 探针结束 ===')
  bot.quit('probe done')
  setTimeout(() => process.exit(0), 800)
})
setTimeout(() => { log('总超时 150s，退出'); process.exit(2) }, 150000)
