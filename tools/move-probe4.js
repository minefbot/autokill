/**
 * 移动诊断探针 v4：区分“账号被冻结” vs “所有假人移动都被拒”
 * - A: 用正确 flags 发原始 position_look 位移包（当前账号）
 * - B: 用全新离线账号连接，测试普通前进 + 原始位移包（如需要先 /register）
 * 用法: PROBE_USER=xxx node tools/move-probe4.js
 */
require('dotenv').config({ quiet: true })

const mineflayer = require('mineflayer')
const HOST = process.env.HOST || 'localhost'
const PORT = parseInt(process.env.PORT || '25565', 10)
const BOT_USERNAME = process.env.PROBE_USER || process.env.BOT_USERNAME || 'XQYXQY'
const VERSION = process.env.VERSION || '1.21.11'
const AUTH = process.env.AUTH || 'offline'
const PSW = process.env.PSW
if (!PSW) { console.error('缺少 PSW'); process.exit(1) }

const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a)
log(`用户名: ${BOT_USERNAME}`)

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: BOT_USERNAME, version: VERSION, auth: AUTH })

bot.once('inject_allowed', () => {
  const client = bot._client
  if (client && typeof client.on === 'function') {
    const reply = (uuid, result) => { try { client.write('resource_pack_receive', { uuid, result }) } catch {} }
    const accept = (data) => {
      const uuid = typeof data.uuid === 'string' ? data.uuid : String(data.uuid)
      log('收到资源包，自动接受')
      reply(uuid, 3)
      reply(uuid, 0)
    }
    client.on('add_resource_pack', accept)
    client.on('resource_pack_send', accept)
  }
})

bot.on('messagestr', (text) => {
  const t = text.trim()
  if (t && !/^(<|$)/.test(t)) log('[系统]', t.slice(0, 70))
})

async function tryForward (name, secs = 2) {
  bot.clearControlStates()
  const s = bot.entity.position.clone()
  bot.setControlState('forward', true)
  await sleep(secs * 1000)
  bot.clearControlStates()
  const moved = s.distanceTo(bot.entity.position)
  log(`[前进] ${name}: 位移 ${moved.toFixed(2)} 格（${s.floored()} → ${bot.entity.position.floored()}）`)
  return moved
}

/** 正确 flags 的原始 position_look 位移包 */
async function rawMove (name, dx, dz, dy = 0, onGround = true) {
  const p = bot.entity.position
  const target = {
    x: p.x + dx, y: p.y + dy, z: p.z + dz,
    yaw: bot.entity.yaw, pitch: bot.entity.pitch,
    flags: { onGround, hasHorizontalCollision: undefined }
  }
  try {
    bot._client.write('position_look', target)
    log(`[raw] ${name}: 已发送 → (${target.x.toFixed(1)}, ${target.y.toFixed(1)}, ${target.z.toFixed(1)}) onGround=${onGround}`)
  } catch (e) {
    log(`[raw] ${name}: 发送失败 ${e.message}`)
    return
  }
  await sleep(1500)
  const moved = p.distanceTo(bot.entity.position)
  log(`[raw] ${name}: 位移 ${moved.toFixed(2)} 格 → 实际 ${bot.entity.position.floored()}`)
}

bot.once('spawn', async () => {
  log(`已进入服务器（版本 ${bot.version}），等待登录`)
  await sleep(1500)
  bot.chat(`/login ${PSW}`)
  await sleep(2000)

  const sp = bot.entity.position
  log(`位置: ${sp.floored()} 脚下=${bot.blockAt(sp.offset(0, -1, 0)) && bot.blockAt(sp.offset(0, -1, 0)).name} onGround=${bot.entity.onGround}`)

  log('=== 原始 position_look 位移（+1 北 / +1 东 / 跳 +0.5） ===')
  await rawMove('+1北', 0, -1)
  await rawMove('+1东', 1, 0)
  await rawMove('跳+0.5', 0, 0, 0.5)

  log('=== 普通前进 2s ===')
  await tryForward('普通前进')

  log('=== 探针结束 ===')
  bot.quit('probe done')
  setTimeout(() => process.exit(0), 800)
})

bot.on('kicked', r => { log('被踢:', typeof r === 'string' ? r : JSON.stringify(r)); process.exit(1) })
bot.on('error', e => log('错误:', e.message))
bot.on('end', r => { log('连接断开:', r); setTimeout(() => process.exit(0), 500) })
setTimeout(() => { log('总超时 90s，退出'); process.exit(2) }, 90000)
