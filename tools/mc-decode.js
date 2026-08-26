/**
 * Minecraft 登录/游戏包解码器（诊断用）
 * 用法:
 *   node tools/mc-decode.js --pcap capture.pcap|.pcapng   # 解析抓包文件
 *   node tools/mc-decode.js --bins c2s.bin s2c.bin        # 解析日志代理导出的字节流
 * 输出: 按方向的包名序列（握手→登录→配置→游戏），标注关键字段
 */
const fs = require('fs')
const zlib = require('zlib')

const VERSION = process.env.VERSION || '1.21.11'
const SERVER_PORT = 25565
const args = process.argv.slice(2)

// ---------- 数据源 ----------
async function readPcap (file) {
  const head = fs.readFileSync(file).subarray(0, 4)
  const magic = head.toString('hex')
  if (magic === '0a0d0d0a') return parsePcapng(fs.readFileSync(file))
  if (magic === 'd4c3b2a1' || magic === 'a1b2c3d4') return parseClassicPcap(file)
  throw new Error('无法识别的抓包格式（仅支持 pcap / pcapng）: ' + magic)
}

function parsePcapng (buf) {
  const packets = []
  let off = 0
  const links = {}
  let endian = 'le'
  while (off + 12 <= buf.length) {
    const type = buf.readUInt32LE(off)
    const len = endian === 'le' ? buf.readUInt32LE(off + 4) : buf.readUInt32BE(off + 4)
    if (type === 0x0A0D0D0A) {
      const bom = buf.readUInt32LE(off + 8)
      endian = bom === 0x1A2B3C4D ? 'le' : 'be'
    } else if (type === 0x00000001) {
      const id = Object.keys(links).length
      links[id] = endian === 'le' ? buf.readUInt16LE(off + 8) : buf.readUInt16BE(off + 8)
    } else if (type === 0x00000006) {
      const ifId = endian === 'le' ? buf.readUInt32LE(off + 8) : buf.readUInt32BE(off + 8)
      const capLen = endian === 'le' ? buf.readUInt32LE(off + 20) : buf.readUInt32BE(off + 20)
      packets.push({ linkType: links[ifId], data: buf.slice(off + 28, off + 28 + capLen) })
    } else if (type === 0x00000003) {
      const capLen = len - 16
      packets.push({ linkType: links[0], data: buf.slice(off + 16, off + 16 + capLen) })
    }
    off += len
  }
  return packets
}

function parseClassicPcap (file) {
  return new Promise((resolve, reject) => {
    const pcap = require('pcap-parser')
    const out = []
    const parser = pcap.parse(file)
    parser.on('packet', ({ data }) => out.push({ linkType: 1, data }))
    parser.on('end', () => resolve(out))
    parser.on('error', reject)
  })
}

function parseFrame (data) {
  if (data.length < 14) return null
  const etherType = data.readUInt16BE(12)
  if (etherType === 0x0800) {
    if (data.length < 34) return null
    const ihl = (data[14] & 0x0f) * 4
    if (data[23] !== 6) return null // TCP only
    const tcpOff = 14 + ihl
    const srcPort = data.readUInt16BE(tcpOff)
    const dstPort = data.readUInt16BE(tcpOff + 2)
    const seq = data.readUInt32BE(tcpOff + 4)
    const dataOff = ((data[tcpOff + 12] >> 4) & 0xf) * 4
    return { srcPort, dstPort, seq, payload: data.slice(tcpOff + dataOff) }
  }
  return null // IPv6 等暂不处理
}

function stitch (segments) {
  segments.sort((a, b) => a.seq - b.seq)
  const parts = []
  let lastEnd = null
  for (const s of segments) {
    if (!s.payload.length) continue
    if (lastEnd === null || s.seq >= lastEnd) {
      parts.push(s.payload)
      lastEnd = s.seq + s.payload.length
    } else if (s.seq + s.payload.length > lastEnd) {
      parts.push(s.payload.slice(lastEnd - s.seq))
      lastEnd = s.seq + s.payload.length
    }
  }
  return Buffer.concat(parts)
}

// ---------- Minecraft 包解码 ----------
const { createDeserializer } = require('minecraft-protocol')
const STATE = { HANDSHAKING: 'handshaking', LOGIN: 'login', CONFIGURATION: 'configuration', PLAY: 'play' }

class DecoderPair {
  constructor () {
    this.shared = { c2s: STATE.HANDSHAKING, s2c: STATE.HANDSHAKING, compression: false, threshold: -1 }
    this.a = new StreamDecoder('C→S', this)
    this.b = new StreamDecoder('S→C', this)
    this.shared.s2c = STATE.LOGIN // 服务器侧在握手后才开口（登录流程用 login；ping 会在 set_protocol 时切 status）
  }
  setState (side, st) {
    if (this.shared[side] === st) return
    this.shared[side] = st
    ;(side === 'c2s' ? this.a : this.b).recreate(st)
  }
  events () { return [...this.a.events, ...this.b.events] }
}

class StreamDecoder {
  constructor (name, pair) {
    this.name = name
    this.pair = pair
    this.isServer = name === 'C→S'
    this.events = []
    this.buf = Buffer.alloc(0)
    this.parser = null
    this.recreate(pair.shared[name])
  }
  recreate (st) {
    this.parser = createDeserializer({ state: st, isServer: this.isServer, version: VERSION })
    this.parser.on('data', (p) => this.onPacket(p))
  }
  side () { return this.name === 'C→S' ? 'c2s' : 's2c' }
  onPacket (parsed) {
    const name = parsed.data.name
    const params = parsed.data.params
    let extra = ''
    try {
      if (name === 'set_protocol' || name === 'handshake') extra = ` nextState=${params.nextState}`
      else if (name === 'login_start') extra = ` name=${params.name}`
      else if (name === 'set_compression') extra = ` threshold=${params.threshold}`
      else if (name === 'settings' || name === 'client_information') extra = ` viewDistance=${params.viewDistance} locale=${params.locale} mainHand=${params.mainHand}`
      else if (name === 'custom_payload' || name === 'plugin_message') extra = ` channel=${JSON.stringify(params.channel)} data=${params.data ? params.data.toString('hex').slice(0, 48) : ''}`
      else if (name === 'login_success') extra = ` uuid=${params.uuid} name=${params.username}`
      else if (name === 'teleport_confirm') extra = ` teleportId=${params.teleportId}`
      else if (name === 'position_look' || name === 'position' || name === 'look') extra = ` onGround=${params.flags ? params.flags.onGround : params.onGround}`
      else if (name === 'login_plugin_request') extra = ` channel=${JSON.stringify(params.channel)} data=${params.data ? params.data.toString('hex').slice(0, 64) : ''}`
      else if (name === 'login_plugin_response') extra = ` success=${params.success} data=${params.data ? params.data.toString('hex').slice(0, 64) : ''}`
      else if (name === 'cookie_request') extra = ` key=${params.key}`
      else if (name === 'resource_pack_receive') extra = ` result=${params.result}`
      else if (name === 'keep_alive' || name === 'keep_alive_acknowledgement' || name === 'ping' || name === 'pong') extra = ''
    } catch (e) {}
    this.events.push({ dir: this.name, name, extra })
    // 状态迁移
    const P = this.pair
    if (name === 'set_protocol' || name === 'handshake') {
      const st = params.nextState === 2 ? STATE.LOGIN : 'status'
      P.setState('c2s', st)
      P.setState('s2c', st)
    } else if (name === 'login_success') {
      P.setState('c2s', STATE.CONFIGURATION)
      P.setState('s2c', STATE.CONFIGURATION)
    } else if (name === 'login_acknowledged') {
      P.setState('c2s', STATE.CONFIGURATION)
    } else if (name === 'finish_configuration') {
      P.setState(this.side(), STATE.PLAY)
      if (this.side() === 's2c') P.setState('c2s', STATE.PLAY)
    } else if (name === 'set_compression') {
      P.shared.compression = true
      P.shared.threshold = params.threshold
    }
  }
  feed (data) {
    this.buf = Buffer.concat([this.buf, data])
    while (true) {
      try {
        const { size, value } = readVarInt(this.buf, 0)
        if (size === 0 || this.buf.length < size + value) break
        let payload = this.buf.slice(size, size + value)
        this.buf = this.buf.slice(size + value)
        if (this.pair.shared.compression) {
          const h = readVarInt(payload, 0)
          if (h.value === 0) {
            payload = payload.slice(h.size)
          } else {
            const dataBuf = zlib.unzipSync(payload.slice(h.size))
            if (dataBuf.length !== h.value) console.error(`[${this.name}] 解压长度不符 ${dataBuf.length} != ${h.value}`)
            payload = dataBuf
          }
        }
        try {
          this.parser.write(payload)
        } catch (e) {
          // 容错：尝试相邻状态
          let ok = false
          for (const st of ['status', STATE.LOGIN, STATE.CONFIGURATION, STATE.PLAY]) {
            if (st === this.pair.shared[this.side()]) continue
            try {
              const alt = createDeserializer({ state: st, isServer: this.isServer, version: VERSION })
              alt.on('data', (p) => this.onPacket(p))
              alt.write(payload)
              this.pair.shared[this.side()] = st
              this.parser = alt
              ok = true
              break
            } catch (e2) {}
          }
          if (!ok) console.error(`[${this.name}] 解析失败(状态=${this.pair.shared[this.side()]}): ${e.message.slice(0, 60)}`)
        }
      } catch (e) {
        break
      }
    }
  }
}

function readVarInt (buf, offset) {
  let result = 0
  let numRead = 0
  let read = offset
  while (true) {
    if (read >= buf.length) return { size: 0, value: 0 }
    const b = buf[read]
    result |= (b & 0x7f) << (7 * numRead)
    numRead++
    read++
    if ((b & 0x80) === 0) break
    if (numRead > 5) throw new Error('varint 过长')
  }
  return { size: numRead, value: result >>> 0 }
}

// ---------- 主流程 ----------
async function main () {
  const pcapIdx = args.indexOf('--pcap')
  const binsIdx = args.indexOf('--bins')
  let streams = { 'C→S': null, 'S→C': null }
  if (pcapIdx >= 0) {
    const packets = await readPcap(args[pcapIdx + 1])
    const segs = { 'C→S': [], 'S→C': [] }
    for (const p of packets) {
      const f = parseFrame(p.data)
      if (!f) continue
      let dir = null
      if (f.dstPort === SERVER_PORT) dir = 'C→S'
      else if (f.srcPort === SERVER_PORT) dir = 'S→C'
      if (dir) segs[dir].push(f)
    }
    streams['C→S'] = stitch(segs['C→S'])
    streams['S→C'] = stitch(segs['S→C'])
    console.log(`pcap 解析: C→S ${streams['C→S'].length} 字节, S→C ${streams['S→C'].length} 字节`)
  } else if (binsIdx >= 0) {
    streams['C→S'] = fs.readFileSync(args[binsIdx + 1])
    streams['S→C'] = fs.readFileSync(args[binsIdx + 2])
  } else {
    console.error('用法: node tools/mc-decode.js --pcap <file> | --bins <c2s.bin> <s2c.bin>')
    process.exit(1)
  }

  const pair = new DecoderPair()
  const STEP = 8192
  const chunks = Math.max(streams['C→S'].length, streams['S→C'].length)
  for (let off = 0; off < chunks; off += STEP) {
    if (off < streams['C→S'].length) pair.a.feed(streams['C→S'].slice(off, off + STEP))
    if (off < streams['S→C'].length) pair.b.feed(streams['S→C'].slice(off, off + STEP))
  }
  for (const e of pair.events()) {
    console.log(`[${e.dir}] ${e.name}${e.extra}`)
  }
  console.log(`\n共 ${pair.events().length} 个包`)
}

main().catch(e => { console.error('错误:', e.message); process.exit(1) })
