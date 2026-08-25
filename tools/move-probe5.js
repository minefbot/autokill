/**
 * 移动诊断探针 v5：判断冻结是“位置相关”（农场保护区）还是“账号级”
 * - 出生点/工作点 → /home cangku → /back 各测一次普通前进
 * - 最后 /mail read 后复测（排除“未读邮件/新手状态”冻结）
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

let teleportAck = false
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
  if (text.includes('传送完成')) teleportAck = true
  const t = text.trim()
  if (t && /传送|冻结|移动|验证|惩罚|封禁|禁|mail|邮件/i.test(t)) log('[系统]', t.slice(0, 90))
})

async function tryForward (name, secs = 2) {
  bot.clearControlStates()
  const s = bot.entity.position.clone()
  bot.setControlState('forward', true)
  await sleep(secs * 1000)
  bot.clearControlStates()
  const moved = s.distanceTo(bot.entity.position)
  log(`[前进] ${name}: 位移 ${moved.toFixed(2)} 格（${s.floored()} → ${bot.entity.position.floored()}）脚下=${bot.blockAt(bot.entity.position.offset(0, -1, 0)) && bot.blockAt(bot.entity.position.offset(0, -1, 0)).name}`)
  return moved
}

/** 发送传送指令并等待“传送完成”，返回是否成功 */
async function teleport (cmd) {
  teleportAck = false
  bot.chat(cmd)
  const end = Date.now() + 8000
  while (Date.now() < end && !teleportAck) await sleep(200)
  const ok = teleportAck
  log(`[传送] ${cmd}: ${ok ? '成功' : '未确认'} → ${bot.entity.position.floored()}`)
  await sleep(1000)
  return ok
}

bot.once('spawn', async () => {
  log(`已进入服务器（版本 ${bot.version}），等待登录`)
  await sleep(1500)
  bot.chat(`/login ${PSW}`)
  await sleep(2000)

  log('=== 1) 出生点/工作点 ===')
  await tryForward('出生点 前进')

  log('=== 2) /home cangku（仓库点） ===')
  if (await teleport('/home cangku')) {
    await tryForward('仓库点 前进')
  } else {
    log('  /home cangku 未成功，跳过')
  }

  log('=== 3) /back（返回工作点） ===')
  if (await teleport('/back')) {
    await tryForward('返回后 前进')
  } else {
    log('  /back 未成功，跳过')
  }

  log('=== 4) /mail read 后复测 ===')
  bot.chat('/mail read')
  await sleep(3000)
  await tryForward('读邮件后 前进')

  log('=== 探针结束 ===')
  bot.quit('probe done')
  setTimeout(() => process.exit(0), 800)
})

bot.on('kicked', r => { log('被踢:', typeof r === 'string' ? r : JSON.stringify(r)); process.exit(1) })
bot.on('error', e => log('错误:', e.message))
bot.on('end', r => { log('连接断开:', r); setTimeout(() => process.exit(0), 500) })
setTimeout(() => { log('总超时 120s，退出'); process.exit(2) }, 120000)
