/* Deep CDP check: WebGL availability, canvas state, 404s, entity errors */
const WebSocket = require('ws')
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
  const tabs = await getJson('http://127.0.0.1:9222/json')
  const page = tabs.find(t => t.type === 'page' && t.url.includes('3001'))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => ws.on('open', r))

  let idc = 0
  const pending = new Map()
  const events = []
  ws.on('message', d => {
    const m = JSON.parse(d)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map(a => a.value !== undefined ? a.value : a.description || '').join(' ')
      events.push(`[console.${m.params.type}] ${text}`.slice(0, 400))
    } else if (m.method === 'Runtime.exceptionThrown') {
      events.push(`[EXCEPTION] ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`.slice(0, 500))
    } else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
      events.push(`[HTTP ${m.params.response.status}] ${m.params.response.url}`)
    }
  })
  const send = (method, params = {}) => new Promise(resolve => {
    const id = ++idc
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

  await send('Runtime.enable')
  await send('Network.enable')
  await send('Page.enable')

  const expr = `(() => {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl')
    const r = window.__pvViewer
    const canvas = r ? r.domElement : null
    return JSON.stringify({
      webgl: !!gl,
      glRenderer: gl ? gl.getParameter(gl.RENDERER) : null,
      viewer: !!r,
      canvasW: canvas ? canvas.width : null,
      canvasH: canvas ? canvas.height : null,
      canvasStyleW: canvas ? canvas.clientWidth : null,
      canvasStyleH: canvas ? canvas.clientHeight : null,
      meshes: r ? r.scene.children.filter(x => x.isMesh).length : null,
      version: r ? r.version : null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyMargin: getComputedStyle(document.body).margin
    })
  })()`
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  console.log('STATE:', res.result.result.value)

  // reload fresh and watch for first errors
  events.length = 0
  await send('Page.reload', { ignoreCache: true })
  await new Promise(r => setTimeout(r, 12000))
  const res2 = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  console.log('STATE2:', res2.result.result.value)
  console.log('--- events after reload ---')
  console.log(events.slice(0, 40).join('\n'))

  // count distinct error types
  const textDisplay = events.filter(e => e.includes('text_display')).length
  console.log('text_display errors:', textDisplay)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
