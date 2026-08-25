/* Browser-side mesh verification: vertex counts, mesh positions vs camera, render stats */
const path = require('path')
const WebSocket = require(path.join('D:/mcbot/node_modules', 'ws'))
const http = require('http')

function getJson (url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, res => {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
    req.end()
  })
}

async function main () {
  const tab = await getJson('http://127.0.0.1:9222/json/new?http://localhost:3001/', 'PUT')
  const ws = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise(r => ws.on('open', r))
  let idc = 0
  const pend = new Map()
  const logs = []
  ws.on('message', d => {
    const m = JSON.parse(d)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 400))
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push('CONSOLE: ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    }
  })
  const send = (method, params = {}) => new Promise(res => {
    const id = ++idc
    const t = setTimeout(() => { pend.delete(id); res({ timeout: true }) }, 10000)
    pend.set(id, m => { clearTimeout(t); res(m) })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  await send('Page.enable')

  // wait for page load + meshing
  await new Promise(r => setTimeout(r, 20000))

  const evalRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const v = window.__pvViewer
      const meshes = v ? v.scene.children.filter(c => c.isMesh) : []
      let verts = 0, empty = 0, nonZero = 0
      let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9
      for (const m of meshes) {
        const p = m.geometry.attributes.position
        if (!p || p.count === 0) { empty++; continue }
        nonZero++
        verts += p.count
        minX = Math.min(minX, m.position.x); maxX = Math.max(maxX, m.position.x)
        minY = Math.min(minY, m.position.y); maxY = Math.max(maxY, m.position.y)
        minZ = Math.min(minZ, m.position.z); maxZ = Math.max(maxZ, m.position.z)
      }
      const cam = v.camera
      const loaded = v ? Object.keys(v.world.loadedChunks).length : -1
      return JSON.stringify({
        meshes: meshes.length, nonZero, empty, totalVerts: verts,
        meshBounds: [minX, minY, minZ, maxX, maxY, maxZ],
        cam: [cam.position.x, cam.position.y, cam.position.z],
        camTarget: cam.target ? [cam.target.x, cam.target.y, cam.target.z] : null,
        loadedChunks: loaded,
        webgl: !!(document.createElement('canvas').getContext('webgl'))
      })
    })()`,
    returnByValue: true
  })
  console.log('STATE:', evalRes.timeout ? 'TIMEOUT' : (evalRes.result?.result?.value ?? JSON.stringify(evalRes)))

  // sample pixels from the WebGL canvas via readPixels
  const px = await send('Runtime.evaluate', {
    expression: `(() => {
      try {
        const v = window.__pvViewer
        const gl = v.renderer.getContext()
        const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
        const buf = new Uint8Array(w * h * 4)
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
        const hist = {}
        for (let i = 0; i < buf.length; i += 16) {
          const key = buf[i] + ',' + buf[i+1] + ',' + buf[i+2]
          hist[key] = (hist[key] || 0) + 1
        }
        const top = Object.entries(hist).sort((a,b) => b[1] - a[1]).slice(0, 5)
        return JSON.stringify({ w, h, top })
      } catch (e) { return 'readPixels error: ' + e.message }
    })()`,
    returnByValue: true
  })
  console.log('PIXELS:', px.timeout ? 'TIMEOUT' : (px.result?.result?.value ?? JSON.stringify(px)))

  console.log('--- logs ---')
  console.log(logs.slice(0, 15).join('\n') || 'none')
  process.exit(0)
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
