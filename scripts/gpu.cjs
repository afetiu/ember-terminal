// Which GPU is Chromium using for Ember, and what does it think of it?
//
//   node_modules/electron/dist/electron.exe scripts/gpu.cjs
//
// On a laptop with two GPUs Windows hands a windowed app the integrated one unless the
// user's Graphics settings say otherwise, and every frame of a 3200x1900 acrylic window
// is composited on whatever this prints.
const { app } = require('electron')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.whenReady().then(async () => {
  const info = await app.getGPUInfo('complete')
  const aux = info.auxAttributes ?? {}
  console.log('renderer     :', aux.glRenderer)
  console.log('vendor       :', aux.glVendor)
  console.log('angle        :', aux.glVersion)
  console.log('features     :', JSON.stringify(app.getGPUFeatureStatus()))
  for (const d of info.gpuDevice ?? []) {
    console.log(`device       : vendor=0x${(d.vendorId ?? 0).toString(16)} device=0x${(d.deviceId ?? 0).toString(16)} active=${d.active} ${d.driverVersion ?? ''}`)
  }
  app.quit()
})
