/**
 * 移动诊断探针 v10：验证“服务器按 player_input 预测移动”假设
 * 原版客户端在移动时发 PlayerInputC2SPacket（输入状态：forward/back/left/right/jump/shift/sprint），
 * mineflayer 从不发 → 服务器预测玩家静止 → 每 200ms 把 bot 拉回。
 * 测试：控制行走 4s（不发 input）→ 控制行走 + 每 tick 发 player_input(forward+sprint) 4s → 对比位移。
 * 运行: node tools/move-probe10.js
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
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('en-GB', { hour12: false })}]`, ...a)

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: BOT_USERNAME, version: VERSION, auth: AUTH })

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

// tick 同步（同 bot.js）
bot.on('physicTick', () => { try { bot._client.write('tick_end', {}) } catch {} })
bot.on('spawn', () => setTimeout(() => { try { bot._client.write('player_loaded', {}) } catch {} }, 3000))

let forcedMoveCount = 0
bot.on('forcedMove', () => { forcedMoveCount++ })
bot.on('kicked', r => { log('被踢:', typeof r === 'string' ? r : JSON.stringify(r)); process.exit(1) })
bot.on('error', e => log('错误:', e.message))
bot.on('end', r => { log('连接断开:', r); setTimeout(() => process.exit(0), 500) })

/** 发送 player_input（inputs 为位标志对象：forward/backward/left/right/jump/shift/sprint） */
let inputTimer = null
function startInput (flags) {
  if (inputTimer) return
  inputTimer = setInterval(() => {
    try { bot._client.write('player_input', { inputs: flags }) } catch (e) { log('player_input 发送失败:', e.message) }
  }, 50)
}
function stopInput () {
  if (inputTimer) { clearInterval(inputTimer); inputTimer = null }
}

async function ctrlWalk (name, yaw, secs, withInput, sprintToo) {
  bot.clearControlStates()
  await bot.look(yaw, 0, true).catch(() => {})
  await sleep(400)
  const s = bot.entity.position.clone()
  bot.setControlState('forward', true)
  if (sprintToo) bot.setControlState('sprint', true)
  if (withInput) startInput({ forward: true, sprint: !!sprintToo })
  const t0 = Date.now()
  while (Date.now() - t0 < secs * 1000) {
    await sleep(250)
    log(`[行走:${name}] t=${((Date.now() - t0) / 1000).toFixed(1)}s pos=${bot.entity.position.x.toFixed(2)},${bot.entity.position.y.toFixed(2)},${bot.entity.position.z.toFixed(2)} og=${bot.entity.onGround}`)
  }
  stopInput()
  bot.clearControlStates()
  await sleep(800)
  const moved = s.distanceTo(bot.entity.position)
  log(`[行走:${name}] 位移 ${moved.toFixed(2)} 格（${s.floored()} → ${bot.entity.position.floored()}） forcedMove累计=${forcedMoveCount}`)
  return moved
}

bot.once('spawn', async () => {
  log(`已进入服务器（版本 ${bot.version}）`)
  await sleep(1500)
  bot.chat(`/login ${PSW}`)
  await sleep(2500)
  await sleep(8000)

  log('=== 测试1：控制行走（不发 player_input）北 4s ===')
  await ctrlWalk('无input', Math.PI, 4, false, false)

  log('=== 测试2：控制行走 + 每tick发 player_input{forward} 北 4s ===')
  await ctrlWalk('带input-forward', Math.PI, 4, true, false)

  log('=== 测试3：疾跑 + 每tick发 player_input{forward,sprint} 北 4s ===')
  await ctrlWalk('疾跑+input', Math.PI, 4, true, true)

  log('=== 探针结束 ===')
  bot.quit('probe done')
  setTimeout(() => process.exit(0), 800)
})
setTimeout(() => { log('总超时 150s，退出'); process.exit(2) }, 150000)
