/**
 * 网页监控服务器（dashboard）
 * - 状态快照（帧率可调）、日志、聊天（查看+发送）、暂停/唤醒控制
 * - 把相机/帧率指令转发给 3D 视图服务器
 */
const express = require('express')
const http = require('http')
const path = require('path')
const { WebSocketServer } = require('ws')

function startMonitor (ctx) {
  const { getBot, getStatus, getLogs, getChats, setPaused, getPaused, getConfig, getViewerControl } = ctx

  const app = express()
  const server = http.createServer(app)
  const wss = new WebSocketServer({ server })

  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')))

  const clients = new Set()

  function broadcast (msg) {
    const data = JSON.stringify(msg)
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(data)
    }
  }

  function sendTo (ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.fps = 2 // 默认 2 帧/秒
    ws.lastSent = 0

    const bot = getBot()
    sendTo(ws, {
      type: 'hello',
      data: {
        username: getConfig().username,
        version: getConfig().version,
        webPort: getConfig().webPort,
        viewerPort: getConfig().viewerPort,
        autoStart: getConfig().autoStart,
        paused: getPaused(),
        connected: !!(bot && bot.entity)
      }
    })
    for (const line of getLogs()) sendTo(ws, { type: 'log', line })
    for (const c of getChats()) sendTo(ws, { type: 'chat', ...c })

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      const bot = getBot()
      switch (msg.type) {
        case 'set_fps': {
          ws.fps = Math.max(0.5, Math.min(30, parseFloat(msg.fps) || 2))
          break
        }
        case 'camera': {
          const vc = getViewerControl()
          if (vc && ['orbit', 'first', 'third', 'top'].includes(msg.mode)) vc.setCameraMode(msg.mode)
          break
        }
        case 'set_fps_viewer': {
          const vc = getViewerControl()
          if (vc) vc.setFps(msg.fps)
          break
        }
        case 'set_paused': {
          setPaused(!!msg.paused)
          break
        }
        case 'chat': {
          const text = String(msg.text || '').trim()
          if (text && bot && bot.chat) bot.chat(text)
          break
        }
        case 'ping': {
          sendTo(ws, { type: 'pong' })
          break
        }
      }
    })

    ws.on('close', () => clients.delete(ws))
  })

  // 状态快照广播（每 200ms 检查一次，按各客户端 fps 限速发送）
  setInterval(() => {
    const now = Date.now()
    const data = getStatus()
    if (!data) return
    for (const ws of clients) {
      if (now - ws.lastSent >= 1000 / ws.fps) {
        ws.lastSent = now
        sendTo(ws, { type: 'status', data })
      }
    }
  }, 200)

  server.listen(getConfig().webPort, () => {
    console.log(`[web] 监控页面已启动: http://localhost:${getConfig().webPort}`)
  })
  server.on('error', (err) => {
    console.error('[web] 启动失败:', err.message)
  })

  return { broadcast, clients }
}

module.exports = { startMonitor }
