/**
 * 移动诊断探针 v2：更细粒度判断“移动被忽略”的根因
 * - 监听 forcedMove（服务器传送/拉回）与 move 事件
 * - 前进时每 200ms 采样位置/速度/onGround
 * - warp 后多等 5 秒再探测（排除传送冻结未解除）
 * - 探测后再次 /warp 重新传送再探测（排除传送状态残留）
 * - 尝试跳跃（space）与下蹲等不同控制组合
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

let forcedMoveCount = 0
bot.on('forcedMove', (pos) => {
  forcedMoveCount++
  log(`[事件] forcedMove(服务器拉回/传送) #${forcedMoveCount}: ${pos.floored()}`)
})
bot.on('mount', () => log('[事件] 坐上了实体(骑乘)'))
bot.on('dismount', () => log('[事件] 下实体'))
bot.on('health', () => {})
bot.on('rain', () => {})

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
  if (/^(?!<)/.test(text) && text.trim()) log('[系统]', text.slice(0, 80))
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
    teleportAck = false
    try { bot.clickWindow(1, 0, 0); await sleep(600) } catch (e) { log('点击失败:', e.message) }
    try { bot.closeWindow(bot.currentWindow) } catch {}
    const end = Date.now() + 6000
    while (Date.now() < end && !teleportAck) await sleep(200)
    if (teleportAck) { log('warp 传送完成'); return true }
  }
  return false
}

/** 按住前进并细粒度采样，返回总位移 */
async function push (name, yaw, secs = 2, extra = null) {
  bot.clearControlStates()
  if (typeof bot.look === 'function') await bot.look(yaw, 0, true).catch(() => {})
  await sleep(400)
  const s = bot.entity.position.clone()
  if (extra) extra()
  bot.setControlState('forward', true)
  const samples = []
  const t0 = Date.now()
  while (Date.now() - t0 < secs * 1000) {
    await sleep(200)
    const p = bot.entity.position
    const v = bot.entity.velocity
    samples.push(`[${((Date.now() - t0) / 1000).toFixed(1)}s] pos=${p.floored()} v=(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}) og=${bot.entity.onGround}`)
  }
  bot.clearControlStates()
  const moved = s.distanceTo(bot.entity.position)
  log(`[探针] ${name}: 位移 ${moved.toFixed(2)} 格（${s.floored()} → ${bot.entity.position.floored()}）`)
  samples.forEach(x => log('   ' + x))
  return moved
}

bot.once('spawn', async () => {
  log(`已进入服务器（版本 ${bot.version}），等待登录`)
  await sleep(1500)
  bot.chat(`/login ${PSW}`)
  await sleep(1500)
  if (!(await warpToWork())) { log('warp 失败，在出生点探测'); }
  await sleep(5000) // 传送后多等 5 秒，排除“传送中冻结”残留

  const p = bot.entity.position
  log(`工作点: ${p.floored()} onGround=${bot.entity.onGround} 站立方块=${bot.blockAt(p) && bot.blockAt(p).name} 脚下=${bot.blockAt(p.offset(0, -1, 0)) && bot.blockAt(p.offset(0, -1, 0)).name}`)

  log('=== 第一轮：普通前进（北/东 各 2s，细粒度采样） ===')
  await push('北 前进', Math.PI)
  await push('东 前进', -Math.PI / 2)

  log('=== 第二轮：跳跃 / 疾跑 / 潜行 ===')
  await push('东 疾跑前进', -Math.PI / 2, 2, () => bot.setControlState('sprint', true))
  await push('北 潜行前进', Math.PI, 2, () => bot.setControlState('sneak', true))
  await push('南 跳跃前进', 0, 2, () => bot.setControlState('jump', true))

  log('=== 第三轮：重新 /warp 后再试（排除传送状态残留） ===')
  await warpToWork()
  await sleep(3000)
  await push('北 前进(warp后)', Math.PI)
  await push('东 前进(warp后)', -Math.PI / 2)

  log(`=== 汇总：forcedMove 次数=${forcedMoveCount} ===`)
  bot.quit('probe done')
  setTimeout(() => process.exit(0), 800)
})

bot.on('kicked', r => { log('被踢:', typeof r === 'string' ? r : JSON.stringify(r)); process.exit(1) })
bot.on('error', e => log('错误:', e.message))
bot.on('end', r => { log('连接断开:', r); setTimeout(() => process.exit(0), 500) })
setTimeout(() => { log('总超时 150s，退出'); process.exit(2) }, 150000)
