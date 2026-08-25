/**
 * 移动诊断探针：直接连接服务器，登录并 warp 到工作点后，
 * 依次朝 北/南/西/东 前进 1.5 秒（普通 / 潜行 / 疾跑），测量实际位移，
 * 用于判断“假人无法移动”是服务器拒绝移动包，还是寻路/朝向问题。
 * 运行: node tools/move-probe.js
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

// 兼容资源包自动接受（同 bot.js 的补丁）
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
    log(`已发送 /warp（第 ${i} 次）`)
    const win = await waitWin(6000)
    if (!win || win.id === 0) { await sleep(2000); continue }
    log(`warp 菜单打开，槽1=${win.slots[1] && win.slots[1].name}`)
    teleportAck = false
    try {
      bot.clickWindow(1, 0, 0)
      await sleep(600)
    } catch (e) { log('点击失败:', e.message) }
    try { bot.closeWindow(bot.currentWindow) } catch {}
    const end = Date.now() + 6000
    while (Date.now() < end && !teleportAck) await sleep(200)
    if (teleportAck) { log('warp 传送完成'); return true }
  }
  return false
}

async function probe (name, yaw, opts = {}) {
  const { sprint = false, sneak = false } = opts
  bot.clearControlStates()
  if (typeof bot.look === 'function') await bot.look(yaw, 0, true).catch(() => {})
  await sleep(300)
  const s = bot.entity.position.clone()
  const sy = bot.entity.yaw
  bot.setControlState('forward', true)
  if (sprint) bot.setControlState('sprint', true)
  if (sneak) bot.setControlState('sneak', true)
  await sleep(1500)
  bot.clearControlStates()
  const moved = s.distanceTo(bot.entity.position)
  const dyaw = bot.entity.yaw - sy
  log(`[探针] ${name}: 位移 ${moved.toFixed(2)} 格 | ${s.floored()} → ${bot.entity.position.floored()} | yaw ${sy.toFixed(2)}→${bot.entity.yaw.toFixed(2)} (Δ${dyaw.toFixed(2)})`)
  return moved
}

bot.once('spawn', async () => {
  log(`已进入服务器（版本 ${bot.version}）`)
  await sleep(1500)
  bot.chat(`/login ${PSW}`)
  log('已发送 /login')
  await sleep(1500)
  if (!(await warpToWork())) { log('warp 失败，在出生点直接探测'); }

  await sleep(1000)
  const p = bot.entity.position
  log(`工作点: ${p.floored()}，站立方块=${bot.blockAt(p) && bot.blockAt(p).name}，脚下=${bot.blockAt(p.offset(0, -1, 0)) && bot.blockAt(p.offset(0, -1, 0)).name}`)

  // 周围 5x5 方块扫描（y 与 y+1 两层，仅列出非空气）
  log('周围方块:')
  for (let dx = -2; dx <= 2; dx++) {
    let row = ''
    for (let dz = -2; dz <= 2; dz++) {
      const b = bot.blockAt(p.offset(dx, 0, dz))
      const b2 = bot.blockAt(p.offset(dx, 1, dz))
      const n = b && b.name !== 'air' ? b.name : ''
      const n2 = b2 && b2.name !== 'air' ? '+' + b2.name : ''
      row += (n || n2 || '·').padEnd(14, ' ')
    }
    log('  ' + row)
  }

  log('=== 开始移动探针 ===')
  await probe('北 前进', Math.PI)
  await probe('南 前进', 0)
  await probe('西 前进', Math.PI / 2)
  await probe('东 前进', -Math.PI / 2)
  await probe('北 潜行前进', Math.PI, { sneak: true })
  await probe('南 疾跑前进', 0, { sprint: true })
  await probe('东 原地跳+前进', -Math.PI / 2, { sprint: false })

  log('=== 探针结束，退出 ===')
  bot.quit('probe done')
  setTimeout(() => process.exit(0), 800)
})

bot.on('kicked', r => { log('被踢:', typeof r === 'string' ? r : JSON.stringify(r)); process.exit(1) })
bot.on('error', e => log('错误:', e.message))
bot.on('end', r => { log('连接断开:', r); setTimeout(() => process.exit(0), 500) })

setTimeout(() => { log('总超时 90s，退出'); process.exit(2) }, 90000)
