/**
 * 移动诊断探针 v3：判断冻结是“服务器不接收移动”还是“mineflayer 移动包/onGround 被拒”
 * 1. 出生点先试普通前进（判断是否位置相关）
 * 2. 原始 position_look 数据包（onGround=true / false）直接位移测试
 * 3. warp 到工作点后再试
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

let teleportAck = false
bot.on('messagestr', (text) => {
  if (text.includes('传送完成')) teleportAck = true
})

function waitWin (timeout) {
  return new Promise(resolve => {
    const t = setTimeout(() => { bot.removeListener('windowOpen', onEv); resolve(null) }, timeout)
    function onEv (w) { clearTimeout(t); resolve(w) }
    bot.once('windowOpen', onEv)
  })
}

async function warpToWork () {
  for (let i = 1; i <= 6; i++) {
    bot.chat('/warp')
    const win = await waitWin(6000)
    if (!win || win.id === 0) { await sleep(2000); continue }
    teleportAck = false
    try { bot.clickWindow(1, 0, 0); await sleep(600) } catch (e) {}
    try { bot.closeWindow(bot.currentWindow) } catch {}
    const end = Date.now() + 6000
    while (Date.now() < end && !teleportAck) await sleep(200)
    if (teleportAck) { log('warp 传送完成'); return true }
  }
  return false
}

/** 普通前进测试 */
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

/** 原始 position_look 数据包位移测试 */
async function rawMove (name, dx, dz, onGround) {
  const p = bot.entity.position
  const target = { x: p.x + dx, y: p.y, z: p.z + dz, yaw: bot.entity.yaw, pitch: bot.entity.pitch, onGround }
  try {
    bot._client.write('position_look', target)
  } catch (e) {
    log(`[raw] ${name}: 发送失败 ${e.message}`)
    return
  }
  await sleep(1200)
  const moved = p.distanceTo(bot.entity.position)
  log(`[raw] ${name} (onGround=${onGround}): 位移 ${moved.toFixed(2)} 格（目标 ${target.x.toFixed(1)},${target.z.toFixed(1)}）→ 实际 ${bot.entity.position.floored()} 脚下=${bot.blockAt(bot.entity.position.offset(0, -1, 0)) && bot.blockAt(bot.entity.position.offset(0, -1, 0)).name}`)
}

bot.once('spawn', async () => {
  log(`已进入服务器（版本 ${bot.version}），等待登录`)
  await sleep(1500)
  bot.chat(`/login ${PSW}`)
  await sleep(1500)

  // ===== 出生点测试 =====
  const sp = bot.entity.position
  log(`出生点: ${sp.floored()} 脚下=${bot.blockAt(sp.offset(0, -1, 0)) && bot.blockAt(sp.offset(0, -1, 0)).name} onGround=${bot.entity.onGround}`)
  log('=== 出生点普通前进 ===')
  await tryForward('出生点 前进')

  log('=== 出生点原始 position_look ===')
  await rawMove('出生点 +X', 1, 0, true)
  await rawMove('出生点 -Z', 0, -1, true)

  // ===== 工作点测试 =====
  log('=== warp 到工作点 ===')
  if (!(await warpToWork())) { log('warp 失败'); }
  await sleep(3000)
  const wp = bot.entity.position
  log(`工作点: ${wp.floored()} 脚下=${bot.blockAt(wp.offset(0, -1, 0)) && bot.blockAt(wp.offset(0, -1, 0)).name} onGround=${bot.entity.onGround}`)

  log('=== 工作点原始 position_look（onGround=true） ===')
  await rawMove('工作点 +X onGround=true', 1, 0, true)
  await rawMove('工作点 -Z onGround=true', 0, -1, true)
  log('=== 工作点原始 position_look（onGround=false） ===')
  await rawMove('工作点 +X onGround=false', 1, 0, false)

  log('=== 工作点普通前进 ===')
  await tryForward('工作点 前进')

  bot.quit('probe done')
  setTimeout(() => process.exit(0), 800)
})

bot.on('kicked', r => { log('被踢:', typeof r === 'string' ? r : JSON.stringify(r)); process.exit(1) })
bot.on('error', e => log('错误:', e.message))
bot.on('end', r => { log('连接断开:', r); setTimeout(() => process.exit(0), 500) })
setTimeout(() => { log('总超时 120s，退出'); process.exit(2) }, 120000)
