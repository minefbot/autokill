// 本地模拟：验证 mineflayer 物理在“服务器每 200ms 重置位置+速度”的情况下能否产生移动
const { Physics, PlayerState } = require('prismarine-physics')
const mcData = require('minecraft-data')('1.21.11')
const { Vec3 } = require('vec3')

const physics = Physics(mcData, { getBlock: (pos) => null }) // 虚空世界（无碰撞）
const entity = {
  position: new Vec3(6289.5, 76, -3434.5),
  velocity: new Vec3(0, 0, 0),
  yaw: Math.PI, pitch: 0,
  onGround: false,
  height: 1.8,
  isInWater: false, isInLava: false, isInWeb: false,
  isCollidedHorizontally: false, isCollidedVertically: false,
  attributes: {},
  effects: {}
}
const control = { forward: true, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
const fakeBot = {
  version: '1.21.11',
  entity,
  jumpQueued: false,
  control,
  inventory: { slots: [] }
}
const world = { getBlock: () => null }
function step () {
  physics.simulatePlayer(new PlayerState(fakeBot, control), world).apply(fakeBot)
}

// 场景1：不重置，连续走 40 tick
console.log('=== 场景1：纯连续行走 40 tick（无服务器干扰） ===')
entity.position.set(6289.5, 76, -3434.5)
entity.velocity.set(0, 0, 0)
entity.onGround = false
for (let i = 0; i < 40; i++) {
  const before = entity.position.clone()
  step()
  if (i % 5 === 0 || entity.onGround) {
    console.log(`tick ${i}: pos=(${entity.position.x.toFixed(3)}, ${entity.position.y.toFixed(3)}, ${entity.position.z.toFixed(3)}) vel=(${entity.velocity.x.toFixed(3)}, ${entity.velocity.y.toFixed(3)}, ${entity.velocity.z.toFixed(3)}) og=${entity.onGround} moved=${entity.position.distanceTo(before).toFixed(3)}`)
  }
}

// 场景2：每 4 tick 重置位置+速度+onGround=false（模拟服务器 200ms 一次的 position sync）
console.log('\n=== 场景2：每 4 tick 服务器重置位置/速度（模拟 forcedMove 同步） ===')
entity.position.set(6289.5, 76, -3434.5)
entity.velocity.set(0, 0, 0)
entity.onGround = false
for (let i = 0; i < 20; i++) {
  const before = entity.position.clone()
  step()
  const moved = entity.position.distanceTo(before)
  console.log(`tick ${i}: moved=${moved.toFixed(4)} pos=(${entity.position.x.toFixed(3)}, ${entity.position.y.toFixed(3)}, ${entity.position.z.toFixed(3)}) vel=(${entity.velocity.x.toFixed(3)}, ${entity.velocity.y.toFixed(3)}, ${entity.velocity.z.toFixed(3)}) og=${entity.onGround}`)
  if ((i + 1) % 4 === 0) {
    // 服务器同步：重置回固定位置
    entity.position.set(6289.5, 76, -3434.5)
    entity.velocity.set(0, 0, 0)
    entity.onGround = false
    console.log(`  --- sync: reset to (6289.5, 76, -3434.5) ---`)
  }
}
