/**
 * 移动诊断探针 v12：取证式探针
 * - 完整打印 S2C position 同步包全部字段（teleportId/x/y/z/dx/dy/dz/yaw/pitch/flags）
 * - 打印 C2S 能力包（mayFly/instabuild 等）与 S2C abilities
 * - 打印脚下/周围方块、站立情况、速度
 * - 跑一次 setControlState('forward') 真实移动，观察服务器怎么回
 * 运行: node tools/move-probe12.js
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
    log('收到资源包，自动接受');
    reply(uuid, 3); reply(uuid, 0)
  }
  client.on('add_resource_pack', accept)
  client.on('resource_pack_send', accept)
  // 观察 S2C abilities
  client.on('abilities', (d) => log('[S2C abilities]', JSON.stringify(d)))
  // 完整打印 S2C position
  client.on('position', (d) => {
    const f = d.flags || {}
    log('[S2C position]', `tid=${d.teleportId} x=${d.x?.toFixed(3)} y=${d.y?.toFixed(3)} z=${d.z?.toFixed(3)} dx=${d.dx?.toFixed(3)} dy=${d.dy?.toFixed(3)} dz=${d.dz?.toFixed(3)} yaw=${d.yaw?.toFixed(1)} pitch=${d.pitch?.toFixed(1)} flags=${JSON.stringify(f)}`)
  })
})

bot.on('physicTick', () => { try { bot._client.write('tick_end', {}) } catch {} })
bot.on('spawn', () => {
  setTimeout(() => { try { bot._client.write('player_loaded', {}) } catch {} }, 3000)
  log('[状态] 坐标', bot.entity.position.floored(), 'onGround=', bot.entity.onGround, 'velocity=', bot.entity.velocity)
})

bot.on('kicked', r => { log('被踢:', typeof r === 'string' ? r : JSON.stringify(r)); process.exit(1) })
bot.on('error', e => log('错误:', e.message))
bot.on('end', r => { log('连接断开:', r); setTimeout(() => process.exit(0), 500) })

function dumpTerrain (label) {
  const p = bot.entity.position
  log(`[地形:${label}] 站在 ${p.floored()} 脚=${p.y}`)
  for (const dy of [-1, 0, 1, 2]) {
    for (const dz of [-1, 0, 1]) {
      const b = bot.blockAt(new (require('vec3'))(Math.floor(p.x), Math.floor(p.y) + dy, Math.floor(p.z) + dz))
      const n = b ? b.name : 'null'
      process.stdout.write(`${n.padEnd(20)}`)
    }
    process.stdout.write(`  (dy=${dy})\n`)
  }
}

bot.once('spawn', async () => {
  log(`已进入服务器（版本 ${bot.version}）`)
  await sleep(1500)
  bot.chat(`/login ${PSW}`)
  await sleep(2500)
  log('[状态] 能力:', JSON.stringify(bot.abilities))
  await sleep(3000)
  dumpTerrain('初始')
  await sleep(1000)
  dumpTerrain('站立后')

  log('=== 移动测试：setControlState(forward) 面向北 5s ===')
  bot.look(Math.PI, 0, true).catch(() => {})
  await sleep(500)
  const s = bot.entity.position.clone()
  bot.setControlState('forward', true)
  for (let i = 0; i < 10; i++) {
    await sleep(500)
    log(`[移动] t=${i * 0.5}s pos=${bot.entity.position.x.toFixed(2)},${bot.entity.position.y.toFixed(2)},${bot.entity.position.z.toFixed(2)} og=${bot.entity.onGround} vel=${bot.entity.velocity ? `${bot.entity.velocity.x.toFixed(2)},${bot.entity.velocity.y.toFixed(2)},${bot.entity.velocity.z.toFixed(2)}` : '-'} 步进`)
  }
  bot.clearControlStates()
  await sleep(800)
  log(`[移动] 位移 ${s.distanceTo(bot.entity.position).toFixed(2)} 格（${s.floored()} → ${bot.entity.position.floored()}）`)
  dumpTerrain('移动后')

  log('=== 探针结束 ===')
  bot.quit('probe done')
  setTimeout(() => process.exit(0), 500)
})
setTimeout(() => { log('总超时 90s，退出'); process.exit(2) }, 90000)