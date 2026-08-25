/* Instrument the browser page: count loadChunk events, addColumn calls, worker messages, fetch status */
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
      logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 500))
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push('CONSOLE: ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 400))
    } else if (m.method === 'Network.loadingFailed') {
      logs.push('NETFAIL: ' + m.params.errorText + ' ' + m.params.type)
    } else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
      logs.push('HTTP' + m.params.response.status + ': ' + m.params.response.url)
    }
  })
  const send = (method, params = {}) => new Promise(res => {
    const id = ++idc
    const t = setTimeout(() => { pend.delete(id); res({ timeout: true }) }, 10000)
    pend.set(id, m => { clearTimeout(t); res(m) })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Page.enable')

  // inject instrumentation via an early script: patch socket.io on before page scripts run
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__stats = { loadChunk: 0, addColumn: 0, workerChunk: 0, workerGeometry: 0, workerErrors: [], fetchStatus: {} };
      (() => {
        const origFetch = window.fetch;
        window.fetch = async (...a) => {
          const r = await origFetch(...a);
          window.__stats.fetchStatus[String(a[0])] = r.status;
          return r;
        };
      })();
    `
  })
  await send('Page.reload', { ignoreCache: true })
  await new Promise(r => setTimeout(r, 6000))

  // now hook viewer internals
  const hook = await send('Runtime.evaluate', {
    expression: `(() => {
      const v = window.__pvViewer
      if (!v) return 'no viewer yet'
      const wr = v.world
      const origAdd = wr.addColumn.bind(wr)
      wr.addColumn = (x, z, chunk) => { window.__stats.addColumn++; return origAdd(x, z, chunk) }
      // count worker geometry messages by wrapping postMessage on workers
      for (const w of wr.workers) {
        const orig = w.postMessage.bind(w)
        w.postMessage = (msg) => {
          if (msg.type === 'chunk') window.__stats.workerChunk++
          orig(msg)
        }
      }
      // hook socket
      const s = window.__pvSocket || null
      return 'hooked'
    })()`,
    returnByValue: true
  })
  console.log('HOOK:', hook.result?.result?.value)

  await new Promise(r => setTimeout(r, 15000))

  const res = await send('Runtime.evaluate', {
    expression: `(() => {
      const v = window.__pvViewer
      const meshes = v.scene.children.filter(c => c.isMesh)
      let verts = 0
      for (const m of meshes) { const p = m.geometry.attributes.position; if (p) verts += p.count }
      return JSON.stringify({
        stats: window.__stats,
        loadedChunks: Object.keys(v.world.loadedChunks).length,
        meshes: meshes.length,
        totalVerts: verts
      })
    })()`,
    returnByValue: true
  })
  console.log('RESULT:', res.result?.result?.value)
  console.log('--- logs ---')
  console.log(logs.slice(0, 20).join('\n') || 'none')
  process.exit(0)
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
