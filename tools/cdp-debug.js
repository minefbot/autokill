/* CDP debug helper: open viewer page, collect console errors, screenshot, check world state */
const WebSocket = require('ws')
const fs = require('fs')
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

function cdp (ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const onMsg = (data) => {
      const m = JSON.parse(data)
      if (m.id === id) {
        ws.removeListener('message', onMsg)
        if (m.error) reject(new Error(JSON.stringify(m.error)))
        else resolve(m.result)
      }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function main () {
  const url = process.argv[2] || 'http://localhost:3001/'
  const shot = process.argv[3] || '/tmp/viewer.png'
  const tabs = await getJson('http://127.0.0.1:9222/json/new?' + encodeURIComponent(url), 'PUT')
  const wsUrl = tabs.webSocketDebuggerUrl
  const ws = new WebSocket(wsUrl)
  await new Promise(r => ws.on('open', r))

  const logs = []
  ws.on('message', data => {
    const m = JSON.parse(data)
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map(a => a.value !== undefined ? a.value : a.description || '').join(' ')
      logs.push(`[console.${m.params.type}] ${text}`)
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      logs.push(`[EXCEPTION] ${d.text} ${d.exception ? (d.exception.description || '') : ''}`.slice(0, 1000))
    } else if (m.method === 'Log.entryAdded') {
      logs.push(`[log.${m.params.entry.level}] ${m.params.entry.text}`)
    }
  })

  await cdp(ws, 1, 'Runtime.enable')
  await cdp(ws, 2, 'Log.enable')
  await cdp(ws, 3, 'Page.enable')
  await cdp(ws, 4, 'Page.navigate', { url })

  // wait for page load + viewer init + chunk meshing
  await new Promise(r => setTimeout(r, 15000))

  const evalRes = await cdp(ws, 5, 'Runtime.evaluate', {
    expression: `(() => {
      const v = window.__pvViewer
      const r = window.__pvRenderer || (v && v.domElement)
      return JSON.stringify({
        hasViewer: !!v,
        sceneChildren: v ? v.scene.children.length : -1,
        meshes: v ? v.scene.children.filter(c => c.isMesh).length : -1,
        hasWorker: !!(window.Worker),
        rendererCanvas: !!r
      })
    })()`,
    returnByValue: true
  })
  console.log('WORLD STATE:', evalRes.result.value)

  await cdp(ws, 6, 'Page.captureScreenshot', { format: 'png' })
    .then(r => { fs.writeFileSync(shot, Buffer.from(r.data, 'base64')); console.log('screenshot saved:', shot) })
    .catch(e => console.log('screenshot failed:', e.message))

  console.log('--- console logs (' + logs.length + ') ---')
  console.log(logs.slice(0, 80).join('\n'))

  ws.close()
  process.exit(0)
}

main().catch(e => { console.error('CDP error:', e.message); process.exit(1) })
