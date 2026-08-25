/**
 * 3D 视图服务器（prismarine-viewer）
 * - 使用重建后的客户端 bundle（web/viewer-src/public，已支持 1.21.11）
 * - socket.io 流式传输区块/实体/位置
 * - 支持相机模式（orbit/first/third/top）与帧率控制，通过 socket.io 下发给浏览器
 */
const express = require('express')
const http = require('http')
const path = require('path')
const { Server } = require('socket.io')
const { WorldView } = require('prismarine-viewer').viewer

const PUBLIC = path.resolve(__dirname, 'viewer-src/public')

function createViewerServer (bot, port, viewDistance = 6) {
  const app = express()
  app.use(express.static(PUBLIC))

  // 轻量状态接口：页面状态栏轮询用（不占 socket.io 连接）
  app.get('/api/status', (req, res) => {
    res.json({
      connected: !!(bot && bot.entity),
      version: bot ? bot.version : null,
      cameraMode: state.cameraMode,
      fps: state.fps
    })
  })

  const server = http.createServer(app)
  const io = new Server(server, { path: '/socket.io' })

  const state = { cameraMode: 'orbit', fps: 0, sockets: [] }

  io.on('connection', (socket) => {
    if (!bot || !bot.entity) return
    socket.emit('version', bot.version)
    socket.emit('camera', { mode: state.cameraMode })
    socket.emit('fps', { fps: state.fps })
    state.sockets.push(socket)

    const worldView = new WorldView(bot.world, viewDistance, bot.entity.position, socket)
    worldView.init(bot.entity.position).catch(err => console.error('[viewer] init 失败:', err.message))

    worldView.on('blockClicked', (block, face, button) => {
      // 保留原插件行为：可扩展为挖掘/放置指令
    })

    function botPosition () {
      const packet = {
        pos: bot.entity.position,
        yaw: bot.entity.yaw,
        pitch: bot.entity.pitch,
        addMesh: true
      }
      socket.emit('position', packet)
      worldView.updatePosition(bot.entity.position)
    }

    bot.on('move', botPosition)
    botPosition() // 立即发送一次初始位置：bot 静止时相机也能定位（否则一片天蓝）
    worldView.listenToBot(bot)

    socket.on('disconnect', () => {
      bot.removeListener('move', botPosition)
      worldView.removeListenersFromBot(bot)
      const i = state.sockets.indexOf(socket)
      if (i >= 0) state.sockets.splice(i, 1)
    })
  })

  server.listen(port, () => {
    console.log(`[viewer] 3D 视图已启动: http://localhost:${port} (${bot.version})`)
  })
  server.on('error', (err) => {
    console.error('[viewer] 启动失败:', err.message)
  })

  return {
    setCameraMode (mode) {
      state.cameraMode = mode
      for (const s of state.sockets) s.emit('camera', { mode })
    },
    setFps (fps) {
      state.fps = Math.max(0, parseInt(fps, 10) || 0)
      for (const s of state.sockets) s.emit('fps', { fps: state.fps })
    },
    close () {
      for (const s of state.sockets) s.disconnect()
      io.close()
      server.close()
    }
  }
}

let current = null

/** 绑定/更换 bot（重连时旧视图服务器关闭，同端口重建；浏览器 socket.io 会自动重连） */
function attachBot (bot, port, viewDistance) {
  if (current) {
    try { current.close() } catch {}
    current = null
  }
  try {
    current = createViewerServer(bot, port, viewDistance)
  } catch (err) {
    console.error('[viewer] 创建失败:', err.message)
  }
  return current
}

module.exports = { attachBot }
