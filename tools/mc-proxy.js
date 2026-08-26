/**
 * Minecraft 日志代理：监听本地端口，转发到真实服务器，同时把两侧字节流写到
 *   c2s.bin（客户端→服务器）与 s2c.bin（服务器→客户端）
 * 用于抓取 mineflayer 连接的完整字节流，配合 tools/mc-decode.js 解码对比。
 * 用法: node tools/mc-proxy.js [本地端口] [目标主机] [目标端口]
 */
const net = require('net')
const fs = require('fs')

const LOCAL_PORT = parseInt(process.argv[2] || '25566', 10)
const TARGET_HOST = process.env.HOST || 'be.bubbo.top'
const TARGET_PORT = parseInt(process.env.PORT || '25565', 10)
const C2S = process.argv[3] === '--stdout' ? null : fs.createWriteStream('c2s.bin')
const S2C = process.argv[3] === '--stdout' ? null : fs.createWriteStream('s2c.bin')

const server = net.createServer((client) => {
  const up = net.connect({ host: TARGET_HOST, port: TARGET_PORT }, () => {
    console.log(`[proxy] ${client.remoteAddress} 已连接 → ${TARGET_HOST}:${TARGET_PORT}`)
  })
  client.on('data', (d) => { if (C2S) C2S.write(d); up.write(d) })
  up.on('data', (d) => { if (S2C) S2C.write(d); client.write(d) })
  client.on('error', () => {})
  up.on('error', () => {})
  client.on('close', () => up.destroy())
  up.on('close', () => client.destroy())
})

server.listen(LOCAL_PORT, () => {
  console.log(`[proxy] 监听 127.0.0.1:${LOCAL_PORT} → ${TARGET_HOST}:${TARGET_PORT}（日志写入 c2s.bin / s2c.bin）`)
})
