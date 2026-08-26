/**
 * 移动诊断探针 v8：S2C 侧抓包 —— 服务器到底对 bot 做了什么
 * - 记录全部 S2C 包名 + 关键字段（position/sync_entity_position 带坐标）
 * - 出生点空闲 5s → 控制行走 3s → warp 到工作点 → 再控制行走 3s
 * - 同时记录 C2S（含 tick_end 频率）
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

const s2cLog = fs.createWriteStream('probe-both.log', { flags: 'w' })
const bot = mineflayer.createBot({ host: HOST, port: PORT, username: BOT_USERNAME, version: VERSION, auth: AUTH })

// 记录 C2S（含 tick_end 等）
const rawWrite = bot._client.write.bind(bot._client)
bot._client.write = (name, params) => {
  s2cLog.write(`[${now()}] -> C2S ${name}\n`)
  return rawWrite(name, params)
}

// 记录 S2C：client 'packet' 事件（meta.name 为包名）
bot._client.on('packet', (data, meta) => {
  if (!meta || !meta.name) return
  const name = meta.name
  if (!/position|teleport|move/.test(name)) return
  let extra = ''
  if (name === 'position' && data) {
    const p = data.position || data.change || data
    extra = ` pos=${JSON.stringify(p)} relatives=${JSON.stringify(data.relatives)} teleportId=${data.teleportId}`
  }  if (name === 'sync_entity_position' && data) {
    extra = ` id=${data.entityId} change=${JSON.stringify(data.change || data.position)} rel=${JSON.stringify(data.relatives)}`
  }
  if (name === 'entity_position' && data) {
    extra = ` id=${data.entityId} delta=${JSON.stringify(data.delta || data.position)}`
  }
  s2cLog.write(`[${now()}] <- S2C ${name}${extra}\n`)})

// 资源包自动接受
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

let forcedMoveCount = 0
bot.on('forcedMove', () => { forcedMoveCount++ })
bot.on('kicked', r => { log('被踢:', typeof r === 'string' ? r : JSON.stringify(r)); process.exit(1) })
bot.on('error', e => log('错误:', e.message))
bot.on('end', r => { log('连接断开:', r); setTimeout(() => process.exit(0), 500) })

const posStr = () => {
  const p = bot.entity ? bot.entity.position : null
  return p ? `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} og=${bot.entity.onGround}` : '?'
}

async function ctrlWalk (name, yaw, secs = 3) {
  bot.clearControlStates()
  await bot.look(yaw, 0, true).catch(() => {})
  await sleep(400)
  const s = bot.entity.position.clone()
  bot.setControlState('forward', true)
  const t0 = Date.now()
  while (Date.now() - t0 < secs * 1000) {
    await sleep(250)
    log(`[行走] t=${((Date.now() - t0) / 1000).toFixed(1)}s pos=${posStr()}`)
  }
  bot.clearControlStates()
  await sleep(800)
  const moved = s.distanceTo(bot.entity.position)
  log(`[行走] ${name}: 位移 ${moved.toFixed(2)} 格（${s.floored()} → ${bot.entity.position.floored()}）`)
  return moved
}

// warp 到工作点（同 bot.js warpToWork 简化版）
async function warpToWork () {
  for (let attempt = 0; attempt < 8; attempt++) {
    bot.chat('/warp')
    log(`已发送 /warp（第 ${attempt + 1} 次）`)
    const win = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 6000)
      const onEv = w => { clearTimeout(timer); resolve(w) }
      bot.once('windowOpen', onEv)
    })
    if (!win || win.id === 0) { log('warp 菜单未打开，重试'); await sleep(2000); continue }
    log(`warp 菜单已打开，点击第一行第二个物品`)
    try { bot.clickWindow(1, 0, 0); await sleep(600) } catch (e) { log('点击失败:', e.message) }
    try { bot.closeWindow(bot.currentWindow) } catch {}
    await sleep(6000) // 等传送
    log(`warp 后位置: ${posStr()}`)
    return true
  }
  return false
}

bot.once('spawn', async () => {
  log(`已进入服务器（版本 ${bot.version}）`)
  await sleep(1500)
  bot.chat(`/login ${PSW}`)
  await sleep(2500)
  await sleep(8000)

  log('=== 出生点空闲 5s（观察服务器对静止 bot 的行为） ===')
  await sleep(5000)
  log(`空闲结束 pos=${posStr()} forcedMove=${forcedMoveCount}`)

  log('=== 出生点控制行走 北 3s ===')
  await ctrlWalk('出生点', Math.PI, 3)
  log(`forcedMove 累计=${forcedMoveCount}`)

  log('=== warp 到工作点 ===')
  const ok = await warpToWork()
  if (!ok) { log('warp 失败，退出'); process.exit(1) }
  await sleep(5000)

  log('=== 工作点空闲 5s ===')
  await sleep(5000)
  log(`空闲结束 pos=${posStr()} forcedMove=${forcedMoveCount}`)

  log('=== 工作点控制行走 北 3s ===')
  await ctrlWalk('工作点', Math.PI, 3)

  log(`=== 探针结束：forcedMove=${forcedMoveCount} ===`)
  bot.quit('probe done')
  setTimeout(() => process.exit(0), 800)
})

setTimeout(() => { log('总超时 150s，退出'); process.exit(2) }, 150000)
