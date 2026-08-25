/**
 * 冒烟测试：用假 bot 对象模拟服务器，驱动 bot.js 完整流程（含网页监控）
 * 运行: node test/smoke.js
 * 覆盖：待机模式(无--auto-start) → 网页唤醒 → 聊天收发 → 狩猎/拾取/进食 → 存仓 → 相机/帧率转发 → 3D 视图流
 * 传送完成判定：以系统聊天出现“传送完成”提示为准（warp 菜单 /home cangku /back 均模拟该提示）
 */
process.env.PSW = 'testpass'
process.env.HOST = '127.0.0.1'
process.env.VERSION = '1.21.11'
process.env.WEB_PORT = '3456'
process.env.VIEWER_PORT = '3457'

const vec3 = require('vec3')
const WebSocket = require('ws')
const ioClient = require('socket.io-client')

// ---------- 事件存储 ----------
const events = {}
const mkItem = (name, count, slot) => ({ name, count, slot, type: name.length })

// ---------- 假 bot ----------
let cursor = null
const chatLog = []
const goalsLog = []
const barrelWin = { id: 1, inventoryStart: 27, inventoryEnd: 63, slots: new Array(63).fill(null) }
const clickTimes = []

// 真实世界（供 3D 视图 WorldView 使用）
const World = require('prismarine-world')('1.21.11')
const fakeWorld = new World(() => new (require('prismarine-chunk')('1.21.11'))())
fakeWorld.setColumn = async (x, z, col) => {
  const colKey = `${x},${z}`
  fakeWorld.columns = fakeWorld.columns || {}
  fakeWorld.columns[colKey] = col
}

const fakeBot = {
  version: '1.21.11',
  username: 'testbot',
  registry: require('minecraft-data')('1.21.11'),
  world: fakeWorld,
  game: { dimension: 'overworld' },
  entity: { id: 1, position: vec3(0, 64, 0), height: 1.8, yaw: 0, pitch: 0 },
  entities: {},
  inventory: {
    slots: new Array(46).fill(null),
    items () { return this.slots.filter(Boolean) }
  },
  heldItem: null,
  health: 20,
  food: 20,
  foodSaturation: 5,
  currentWindow: null,
  quickBarSlot: 0,
  QUICK_BAR_START: 36,
  pathfinder: {
    setGoal (goal, dynamic) { goalsLog.push({ goal: goal && goal.constructor && goal.constructor.name, dynamic }) },
    setMovements () {},
    stop () {},
    isMoving () { return false } // 模拟寻路不可达（安全点寻路立即中断）
  },
  blockAt (pos) {
    // 模拟地面：y=63 为实心方块（脚下），其余为空气
    return pos && Math.floor(pos.y) === 63
      ? { boundingBox: 'block', name: 'grass_block' }
      : { boundingBox: 'empty', name: 'air' }
  },
  chat (m) {
    chatLog.push(m)
    console.log('  [chat]', m)
    if (m === '/warp') {
      // 模拟服务器弹出 warp 菜单（箱子界面）
      const win = { id: 9, inventoryStart: 27, inventoryEnd: 63, slots: new Array(63).fill(null) }
      win.slots[1] = { name: '工作点', count: 1, slot: 1 }
      setTimeout(() => {
        fakeBot.currentWindow = win
        fakeBot.emit('windowOpen', win)
        console.log('  [sim] warp 菜单打开')
      }, 300)
    } else if (m === '/home cangku') {
      // 模拟传送完成：系统聊天出现“传送完成”（部分匹配，bot.js 以此判定成功）
      setTimeout(() => {
        fakeBot.entity.position = vec3(100, 64, 100)
        fakeBot.emit('messagestr', '已传送至仓库点，传送完成！')
        console.log('  [sim] 传送到仓库（系统提示: 传送完成）')
      }, 1200)
    } else if (m === '/back') {
      setTimeout(() => {
        fakeBot.entity.position = vec3(10, 64, 10)
        fakeBot.emit('messagestr', '已返回工作点，传送完成！')
        console.log('  [sim] 返回工作点（系统提示: 传送完成）')
      }, 1200)
    }
  },
  attack (e) { console.log('  [attack]', e.name, '@', e.position) },
  lookAt () { return Promise.resolve() },
  equip () { return Promise.resolve() },
  activateItem () {},
  deactivateItem () {},
  quit (r) { console.log('  [quit]', r) },
  clickWindow (slot, btn, mode) {
    const win = fakeBot.currentWindow || fakeBot.inventory
    if (win && win.id === 9 && slot === 1 && mode === 0) {
      // warp 菜单：点击第一行第二个物品触发传送，随后系统提示“传送完成”
      fakeBot.currentWindow = null
      setTimeout(() => {
        fakeBot.entity.position = vec3(10, 64, 10)
        fakeBot.emit('messagestr', 'warp 传送完成！')
        console.log('  [sim] warp 传送完成（系统提示: 传送完成）')
      }, 800)
      return
    }    if (slot === -999) { cursor = null; return }
    if (mode === 0) {
      if (cursor) {
        const dest = win.slots[slot]
        if (dest && dest.name === cursor.name) { dest.count += cursor.count; cursor = null }
        else { win.slots[slot] = cursor; cursor = dest }
      } else {
        cursor = win.slots[slot]
        win.slots[slot] = null
      }
    } else if (mode === 1) {
      const it = win.slots[slot]
      if (it) {
        const dest = win.slots.findIndex((s, i) => i < win.inventoryStart && !s)
        if (dest >= 0) { win.slots[dest] = it; win.slots[slot] = null }
        console.log(`  [click shift] ${it.name} x${it.count} → 容器槽 ${dest}`)
        clickTimes.push(Date.now())
      }
    }
    if (win !== fakeBot.inventory) {
      for (let i = win.inventoryStart; i < win.inventoryEnd; i++) {
        fakeBot.inventory.slots[i - (win.inventoryStart - 9)] = win.slots[i]
      }
    }
  },
  closeWindow () { fakeBot.currentWindow = null },
  activateBlock () {
    console.log('  [activateBlock] barrel')
    setTimeout(() => {
      barrelWin.slots.fill(null)
      for (let i = 9; i < 45; i++) {
        const it = fakeBot.inventory.slots[i]
        if (it) {
          const winSlot = 27 + (i - 9)
          barrelWin.slots[winSlot] = { ...it, slot: winSlot }
        }
      }
      fakeBot.currentWindow = barrelWin
      fakeBot.emit('windowOpen', barrelWin)
    }, 100)
  },
  findBlock () { return { name: 'barrel', position: vec3(100, 64, 100) } },
  loadPlugin () {},
  on (ev, fn) { (events[ev] = events[ev] || []).push(fn) },
  once (ev, fn) { (events[ev] = events[ev] || []).push(fn) },
  removeListener (ev, fn) { events[ev] = (events[ev] || []).filter(f => f !== fn) },
  emit (ev, ...a) { (events[ev] || []).slice().forEach(fn => fn(...a)) }
}

// ---------- 加载 bot.js ----------
const mineflayer = require('mineflayer')
mineflayer.createBot = () => fakeBot
require('../bot.js')

// ---------- 网页客户端 ----------
const dashMsgs = []
let lastStatus = null
let firstStatusPaused = null
const dash = new WebSocket('ws://127.0.0.1:3456')
dash.on('message', raw => {
  const m = JSON.parse(raw.toString())
  dashMsgs.push(m)
  if (m.type === 'status') {
    lastStatus = m.data
    if (firstStatusPaused === null) firstStatusPaused = m.data.paused
  }
})

const viewerMsgs = []
const viewerSock = ioClient('http://127.0.0.1:3457', {
  path: '/socket.io',
  transports: ['websocket']
})
viewerSock.onAny((ev, ...args) => viewerMsgs.push([ev, ...args]))

const sendDash = (o) => { if (dash.readyState === 1) dash.send(JSON.stringify(o)) }

// 模拟移动事件（真实 mineflayer 移动时触发，3D 视图靠它推流位置）
setInterval(() => fakeBot.emit('move'), 1000)

// ---------- 场景编排 ----------
setTimeout(() => {
  // 场景1: 出生（血低饥饿、有牛、有剑、有熟猪肉）
  fakeBot.health = 10
  fakeBot.food = 10
  fakeBot.inventory.slots[15] = mkItem('iron_sword', 1, 15)
  fakeBot.inventory.slots[20] = mkItem('cooked_porkchop', 3, 20)
  fakeBot.entities[100] = { id: 100, name: 'cow', type: 'mob', position: vec3(5, 64, 0), height: 1.4, width: 0.9 }
  fakeBot.emit('spawn')
  console.log('  [sim] 出生（待机模式）')
}, 500)

// 模拟食用完成
setTimeout(() => {
  const off = fakeBot.inventory.slots[45]
  if (off) { off.count -= 1; console.log('  [sim] 副手熟猪肉数量减少 → 食用完成') }
}, 8000)

// 模拟牛死亡与掉落物
setTimeout(() => {
  console.log('  [sim] 牛死亡')
  fakeBot.emit('entityDead', fakeBot.entities[100])
  fakeBot.entities[101] = { id: 101, name: 'item', type: 'object', position: vec3(5, 64, 0) }
  fakeBot.emit('entitySpawn', fakeBot.entities[101])
  setTimeout(() => {
    console.log('  [sim] 掉落物被拾取')
    delete fakeBot.entities[101]
    fakeBot.emit('entityGone', { id: 101 })
  }, 800)
}, 10500)

// 场景2: 物品栏装满 → 触发存仓
setTimeout(() => {
  console.log('  [sim] 物品栏装满')
  for (let i = 9; i < 45; i++) {
    if (!fakeBot.inventory.slots[i]) {
      fakeBot.inventory.slots[i] = mkItem(i % 3 === 0 ? 'dirt' : i % 3 === 1 ? 'cobblestone' : 'wheat', 64, i)
    }
  }
  fakeBot.inventory.slots[12] = mkItem('cooked_porkchop', 2, 12)
}, 17000)

// 场景3: 容器满后腾出空位
setTimeout(() => {
  if (barrelWin.slots.slice(0, 27).some(Boolean)) {
    console.log('  [sim] 其他玩家取走容器物品（腾出空位）')
    barrelWin.slots.fill(null, 0, 27)
  }
}, 45000)

// ---------- 断言 ----------
const results = []
function check (name, cond) { results.push([name, !!cond]); console.log((cond ? '  ✓ ' : '  ✗ ') + name) }

setTimeout(() => {
  console.log('\n===== 网页监控断言 =====')
  check('收到 hello（含待机标记）', dashMsgs.some(m => m.type === 'hello' && m.data.paused === true))
  check('收到状态快照', lastStatus !== null)
  check('初始为待机(paused=true)', firstStatusPaused === true)
  check('状态包含生命/坐标/目标字段', lastStatus && lastStatus.health === 10 && lastStatus.pos && 'target' in lastStatus)
  check('发送聊天成功（bot.chat 收到）', chatLog.includes('hello world'))
  check('唤醒后 paused=false', lastStatus && lastStatus.paused === false)
  check('3D 视图收到 version 1.21.11', viewerMsgs.some(m => m[0] === 'version' && m[1] === '1.21.11'))
  check('3D 视图收到位置(position)', viewerMsgs.some(m => m[0] === 'position'))
  check('相机模式转发到 3D 视图', viewerMsgs.some(m => m[0] === 'camera' && m[1] && m[1].mode === 'top'))
  check('帧率指令转发到 3D 视图', viewerMsgs.some(m => m[0] === 'fps' && m[1] && m[1].fps === 5))

  console.log('\n===== 主流程断言 =====')
  check('发送 /login testpass', chatLog.includes('/login testpass'))
  check('发送 /warp（warp 菜单传送）', chatLog.includes('/warp'))
  check('发送 /home cangku', chatLog.includes('/home cangku'))
  check('发送 /back', chatLog.includes('/back'))
  check('攻击过牛(GoalFollow)', goalsLog.some(g => g.goal === 'GoalFollow'))
  check('拾取掉落物(GoalNear)', goalsLog.some(g => g.goal === 'GoalNear'))
  check('熟猪肉被放入副手(槽45)', fakeBot.inventory.slots[45] && fakeBot.inventory.slots[45].name === 'cooked_porkchop')
  check('副手数量减少(食用完成)', fakeBot.inventory.slots[45] && fakeBot.inventory.slots[45].count === 2)
  check('剑被保留', fakeBot.inventory.slots[15] && fakeBot.inventory.slots[15].name === 'iron_sword')
  check('熟猪肉被保留', fakeBot.inventory.slots[12] && fakeBot.inventory.slots[12].name === 'cooked_porkchop')
  const containerItems = barrelWin.slots.slice(0, 27).filter(Boolean)
  check('容器中有移入的物品', containerItems.length > 0)
  console.log('  容器中物品:', containerItems.map(i => `${i.name}x${i.count}`).join(', '))
  let maxPerSec = 0
  for (const t of clickTimes) {
    const inWindow = clickTimes.filter(x => x >= t && x < t + 1000).length
    if (inWindow > maxPerSec) maxPerSec = inWindow
  }
  check(`容器操作限速（峰值 ${maxPerSec}/秒 ≤ 4）`, maxPerSec <= 4)
  const remaining = fakeBot.inventory.slots.slice(9, 45).filter(Boolean)
  check('存仓后物品栏只剩剑/熟猪肉', remaining.every(i => i.name === 'iron_sword' || i.name === 'cooked_porkchop'))

  const fail = results.filter(r => !r[1])
  console.log(fail.length ? `\n${fail.length} 项失败` : '\n全部通过')
  process.exit(fail.length ? 1 : 0)
}, 60000)

// 通过网页驱动：待机→唤醒→聊天→相机/帧率
setTimeout(() => {
  console.log('  [web] 待机中，发送聊天并唤醒…')
  sendDash({ type: 'chat', text: 'hello world' })
  setTimeout(() => {
    sendDash({ type: 'set_paused', paused: false })
    setTimeout(() => {
      sendDash({ type: 'camera', mode: 'top' })
      sendDash({ type: 'set_fps_viewer', fps: 5 })
    }, 300)
  }, 300)
}, 7000)
