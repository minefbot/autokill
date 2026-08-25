/**
 * 移动诊断探针 v6：模拟原版客户端行走
 * - 原始 position_look 包按 20Hz、原版步行速度（4.317 格/秒）、onGround=true 发送
 * - 对比：mineflayer 控制状态行走（无疾跑）
 * - 目的：判断服务器是拒绝“mineflayer 物理/控制状态”还是拒绝“任何非原版移动包”
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
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a)

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
  if (t && /传送|冻结|移动|惩罚|飞行|验证/i.test(t)) log('[系统]', t.slice(0, 90))
})

/** 原版风格行走：20Hz 原始 position_look，恒定速度，onGround=true */
async function vanillaWalk (name, yaw, dx, dz, secs = 2) {
  const p = bot.entity.position
  const speed = 4.317 // 原版步行速度 格/秒
  const vx = Math.cos(yaw) * speed / 20 * 0 // 方向由 dx/dz 直接给
  const steps = secs * 20
  const per = { x: dx / secs / 20, z: dz / secs / 20 }
  let x = p.x
  let z = p.z
  const t0 = Date.now()
  for (let i = 0; i < steps; i++) {
    x += per.x
    z += per.z
    try {
      bot._client.write('position_look', {
        x, y: p.y, z,
        yaw: Math.atan2(-dx, -dz), pitch: 0,
        flags: { onGround: true, hasHorizontalCollision: false }
      })
    } catch (e) { log(`[vanilla] ${name}: 发送失败 ${e.message}`); break }
    await sleep(50)
  }
  await sleep(1200)
  const moved = p.distanceTo(bot.entity.position)
  log(`[vanilla] ${name}: 发送 ${steps} 包，位移 ${moved.toFixed(2)} 格（${p.floored()}，脚下=${bot.blockAt(p.offset(0, -1, 0)) && bot.blockAt(p.offset(0, -1, 0)).name}）`)
  return moved
}

/** mineflayer 控制状态行走（无疾跑） */
async function ctrlWalk (name, yaw, secs = 2) {
  bot.clearControlStates()
  if (typeof bot.look === 'function') await bot.look(yaw, 0, true).catch(() => {})
  await sleep(400)
  const s = bot.entity.position.clone()
  bot.setControlState('forward', true)
  await sleep(secs * 1000)
  bot.clearControlStates()
  const moved = s.distanceTo(bot.entity.position)
  log(`[ctrl] ${name}: 位移 ${moved.toFixed(2)} 格（${s.floored()} → ${bot.entity.position.floored()}）`)
  return moved
}

bot.once('spawn', async () => {
  log(`已进入服务器（版本 ${bot.version}），等待登录与稳定`)
  await sleep(1500)
  bot.chat(`/login ${PSW}`)
  await sleep(2500)
  await sleep(8000) // 等 8 秒再动（排除登录/传送后立刻移动被冻结）
  const p = bot.entity.position
  log(`当前位置: ${p.floored()} onGround=${bot.entity.onGround} 脚下=${bot.blockAt(p.offset(0, -1, 0)) && bot.blockAt(p.offset(0, -1, 0)).name}`)

  log('=== 1) 原版风格原始包行走 北 2s ===')
  await vanillaWalk('北 原版包', Math.PI, 0, -1, 2)
  log('=== 2) 原版风格原始包行走 东 2s ===')
  await vanillaWalk('东 原版包', -Math.PI / 2, 1, 0, 2)
  log('=== 3) mineflayer 控制状态行走(无疾跑) 北 2s ===')
  await ctrlWalk('北 控制状态', Math.PI, 2)
  log('=== 4) mineflayer 控制状态行走(疾跑) 东 2s ===')
  bot.clearControlStates()
  if (typeof bot.look === 'function') await bot.look(-Math.PI / 2, 0, true).catch(() => {})
  await sleep(400)
  const s = bot.entity.position.clone()
  bot.setControlState('forward', true)
  bot.setControlState('sprint', true)
  await sleep(2000)
  bot.clearControlStates()
  log(`[ctrl] 东 疾跑: 位移 ${s.distanceTo(bot.entity.position).toFixed(2)} 格`)

  log('=== 探针结束 ===')
  bot.quit('probe done')
  setTimeout(() => process.exit(0), 800)
})

bot.on('kicked', r => { log('被踢:', typeof r === 'string' ? r : JSON.stringify(r)); process.exit(1) })
bot.on('error', e => log('错误:', e.message))
bot.on('end', r => { log('连接断开:', r); setTimeout(() => process.exit(0), 500) })
setTimeout(() => { log('总超时 120s，退出'); process.exit(2) }, 120000)
