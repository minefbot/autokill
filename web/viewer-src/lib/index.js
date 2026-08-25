/* global THREE */

global.THREE = require('three')
const TWEEN = require('@tweenjs/tween.js')
require('three/examples/js/controls/OrbitControls')

const { Viewer, Entity } = require('../viewer')

const io = require('socket.io-client')
const socket = io({
  path: window.location.pathname + 'socket.io'
})

let firstPositionUpdate = true

const renderer = new THREE.WebGLRenderer()
renderer.setPixelRatio(window.devicePixelRatio || 1)
renderer.setSize(window.innerWidth, window.innerHeight)
document.body.appendChild(renderer.domElement)

const viewer = new Viewer(renderer)

// 暴露给外部控制脚本（帧率、相机）
window.__pvViewer = viewer
window.__pvTHREE = THREE

let controls = new THREE.OrbitControls(viewer.camera, renderer.domElement)
window.__pvControls = controls

// ---- 监控控制：帧率 + 相机模式（orbit 轨道 / first 第一人称 / third 第三人称 / top 俯视） ----
let cameraMode = 'orbit'
let fpsLimit = 0 // 0 = 不限
let lastFrame = 0
let lastPos = null
let lastYaw = 0
let lastPitch = 0

socket.on('camera', ({ mode }) => {
  cameraMode = mode
  if (controls) {
    controls.dispose()
    controls = null
    window.__pvControls = null
  }
  if (mode === 'orbit') {
    controls = new THREE.OrbitControls(viewer.camera, renderer.domElement)
    window.__pvControls = controls
    if (lastPos) controls.target.set(lastPos.x, lastPos.y, lastPos.z)
    controls.update()
  }
})

socket.on('fps', ({ fps }) => {
  fpsLimit = Math.max(0, parseInt(fps, 10) || 0)
})

function animate (t) {
  window.requestAnimationFrame(animate)
  if (fpsLimit > 0 && t - lastFrame < 1000 / fpsLimit) return // 帧率限制
  lastFrame = t
  if (controls) controls.update()
  viewer.update()
  if (cameraMode === 'first' && lastPos) {
    viewer.setFirstPersonCamera(lastPos, lastYaw, lastPitch)
  } else if (cameraMode === 'third' && lastPos) {
    const d = 6
    const px = lastPos.x - Math.sin(lastYaw) * d
    const pz = lastPos.z - Math.cos(lastYaw) * d
    viewer.camera.position.set(px, lastPos.y + 3, pz)
    viewer.camera.lookAt(lastPos.x, lastPos.y + 1.5, lastPos.z)
  } else if (cameraMode === 'top' && lastPos) {
    viewer.camera.position.set(lastPos.x, lastPos.y + 60, lastPos.z)
    viewer.camera.lookAt(lastPos.x, lastPos.y, lastPos.z)
  }
  renderer.render(viewer.scene, viewer.camera)
}
window.requestAnimationFrame(animate)

window.addEventListener('resize', () => {
  viewer.camera.aspect = window.innerWidth / window.innerHeight
  viewer.camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

socket.on('version', (version) => {
  if (!viewer.setVersion(version)) {
    return false
  }

  firstPositionUpdate = true
  viewer.listen(socket)

  let botMesh
  socket.on('position', ({ pos, addMesh, yaw, pitch }) => {
    lastPos = pos
    if (yaw !== undefined && pitch !== undefined) {
      lastYaw = yaw
      lastPitch = pitch
      if (cameraMode === 'first') {
        if (controls) {
          controls.dispose()
          controls = null
          window.__pvControls = null
        }
        viewer.setFirstPersonCamera(pos, yaw, pitch)
        return
      }
    }
    if (pos.y > 0 && firstPositionUpdate) {
      if (!controls) {
        controls = new THREE.OrbitControls(viewer.camera, renderer.domElement)
        window.__pvControls = controls
      }
      controls.target.set(pos.x, pos.y, pos.z)
      viewer.camera.position.set(pos.x, pos.y + 20, pos.z + 20)
      controls.update()
      firstPositionUpdate = false
    }
    if (addMesh) {
      if (!botMesh) {
        botMesh = new Entity('1.16.4', 'player', viewer.scene).mesh
        viewer.scene.add(botMesh)
      }
      new TWEEN.Tween(botMesh.position).to({ x: pos.x, y: pos.y, z: pos.z }, 50).start()

      const da = (yaw - botMesh.rotation.y) % (Math.PI * 2)
      const dy = 2 * da % (Math.PI * 2) - da
      new TWEEN.Tween(botMesh.rotation).to({ y: botMesh.rotation.y + dy }, 50).start()
    }
  })
})
