/* Replicate the client-side meshing pipeline in Node to find why nothing renders */
const { io } = require('socket.io-client')
const path = require('path')

const WorldMod = require('../web/viewer-src/viewer/lib/world')
const { getSectionGeometry } = require('../web/viewer-src/viewer/lib/models')
const blocksStates = require('../web/viewer-src/public/blocksStates/1.21.11.json')

async function main () {
  // 1. grab one real chunk from the viewer server
  const chunk = await new Promise((resolve) => {
    const s = io('http://localhost:3001', { path: '/socket.io', transports: ['websocket'] })
    s.on('loadChunk', d => { resolve(d); s.close() })
    setTimeout(() => { console.log('TIMEOUT waiting chunk'); process.exit(1) }, 15000)
  })
  console.log('chunk at', chunk.x, chunk.z, 'json type:', typeof chunk.chunk, 'len:', chunk.chunk.length)

  // 2. build world + add column
  const World = WorldMod.World
  const world = new World('1.21.11')
  try {
    world.addColumn(chunk.x, chunk.z, chunk.chunk)
    console.log('addColumn OK, columns:', Object.keys(world.columns).length)
  } catch (e) {
    console.log('addColumn FAILED:', e.message)
    console.log(e.stack.split('\n').slice(0, 6).join('\n'))
    process.exit(0)
  }

  // 3. check a few blocks
  const col = world.getColumn(chunk.x, chunk.z)
  console.log('chunk sections:', col.sections.length, 'worldHeight:', col.worldHeight, 'minY:', col.minY)
  let nonAir = 0, total = 0
  for (let y = col.minY; y < col.minY + col.worldHeight; y += 16) {
    for (let z = 0; z < 16; z += 4) {
      for (let x = 0; x < 16; x += 4) {
        total++
        const sid = col.getBlockStateId({ x, y, z })
        if (sid !== 0) nonAir++
      }
    }
  }
  console.log('non-air sampled:', nonAir, '/', total)

  // 4. mesh a section around the surface (y=128..144 since bot is at y=148)
  let found = false
  for (let sy = 128; sy < 288; sy += 16) {
    try {
      const geo = getSectionGeometry(chunk.x, sy, chunk.z, world, blocksStates)
      console.log(`section y=${sy}: positions=${geo.positions.length / 3} indices=${geo.indices.length} uvs=${geo.uvs.length / 2}`)
      if (geo.positions.length > 0) found = true
    } catch (e) {
      console.log(`section y=${sy} ERROR:`, e.message)
    }
  }
  console.log('found geometry:', found)
  process.exit(0)
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
