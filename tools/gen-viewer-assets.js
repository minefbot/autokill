/**
 * 为 prismarine-viewer 生成 1.21.11 的方块模型与纹理资源
 * 策略：
 *  - 以 1.21.4 的 vanilla blocks_states.json / blocks_models.json 为基础（旧方块真实模型）
 *  - 1.21.5+ 新增方块合成 cube_all 方块（纹理缺失则用 missing_texture）
 *  - 纹理图集从 1.21.4 的 blocks 纹理目录重新生成，与 blocksStates 一致
 * 用法: node tools/gen-viewer-assets.js
 */
const fs = require('fs')
const path = require('path')
const { makeTextureAtlas } = require('prismarine-viewer/viewer/lib/atlas')
const { prepareBlocksStates } = require('prismarine-viewer/viewer/lib/modelsBuilder')
const mcData = require('minecraft-data')('1.21.11')

const PUBLIC = path.resolve(__dirname, '../web/viewer-src/public')
const TEX_DIR = path.join(PUBLIC, 'textures/1.21.4')
const OUT_TEX_DIR = path.join(PUBLIC, 'textures/1.21.11')

console.log('[1] 读取 1.21.4 vanilla 数据...')
const blocksStates = JSON.parse(fs.readFileSync(path.join(TEX_DIR, 'blocks_states.json'), 'utf8'))
const blocksModels = JSON.parse(fs.readFileSync(path.join(TEX_DIR, 'blocks_models.json'), 'utf8'))

const texFiles = new Set(fs.readdirSync(path.join(TEX_DIR, 'blocks')).map(f => f.replace(/\.png$/, '')))

console.log('[2] 补充 1.21.11 新增方块...')
let added = 0
let missingTex = 0
for (const block of mcData.blocksArray) {
  if (block.name in blocksStates) continue
  const tex = texFiles.has(block.name) ? 'minecraft:block/' + block.name : 'minecraft:block/missing_texture'
  if (!texFiles.has(block.name)) missingTex++
  blocksStates[block.name] = { variants: { '': { model: 'minecraft:block/' + block.name } } }
  blocksModels[block.name] = { parent: 'minecraft:block/cube_all', textures: { all: tex } }
  added++
}
console.log(`  新增 ${added} 个方块（其中 ${missingTex} 个纹理缺失 → missing_texture）`)

console.log('[3] 生成纹理图集与 blocksStates...')
const assets = { directory: TEX_DIR, blocksStates, blocksModels }
const atlas = makeTextureAtlas(assets)
const outStates = prepareBlocksStates(assets, atlas)

fs.mkdirSync(path.join(PUBLIC, 'blocksStates'), { recursive: true })
fs.mkdirSync(path.join(PUBLIC, 'textures'), { recursive: true })
fs.writeFileSync(path.join(PUBLIC, 'blocksStates/1.21.11.json'), JSON.stringify(outStates))
fs.writeFileSync(path.join(PUBLIC, 'textures/1.21.11.png'), atlas.image)
console.log('  ✓ blocksStates/1.21.11.json, textures/1.21.11.png')

console.log('[4] 复制实体纹理目录 (textures/1.21.11/)...')
fs.cpSync(TEX_DIR, OUT_TEX_DIR, { recursive: true })
console.log('  ✓ textures/1.21.11/')
console.log('完成')
