/**
 * 邮件/状态诊断：读取该账号的邮件（可能含冻结/惩罚通知）与常用状态命令输出
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
      reply(uuid, 3)
      reply(uuid, 0)
    }
    client.on('add_resource_pack', accept)
    client.on('resource_pack_send', accept)
  }
})

bot.on('messagestr', (text) => {
  const t = text.trim()
  if (t && !/^(<|$)/.test(t)) log('[系统]', t.slice(0, 160))
})

bot.once('spawn', async () => {
  log('已进入服务器')
  await sleep(1500)
  bot.chat(`/login ${PSW}`)
  await sleep(2500)
  for (let i = 1; i <= 5; i++) {
    log(`--- /mail read ${i} ---`)
    bot.chat(`/mail read ${i}`)
    await sleep(2500)
  }
  log('--- 完成，退出 ---')
  bot.quit('done')
  setTimeout(() => process.exit(0), 500)
})

bot.on('kicked', r => { log('被踢:', typeof r === 'string' ? r : JSON.stringify(r)); process.exit(1) })
bot.on('error', e => log('错误:', e.message))
bot.on('end', r => { log('连接断开:', r); setTimeout(() => process.exit(0), 500) })
setTimeout(() => { log('超时退出'); process.exit(2) }, 60000)
