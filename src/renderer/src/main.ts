import '@xterm/xterm/css/xterm.css'
import './styles/app.css'
import './styles/onboarding.css'
import './styles/loom.css'
import './styles/fonts.css'
import './styles/basalt.css'
import { App } from './ui/App'
import { loadFont } from './core/fonts'

async function boot(): Promise<void> {
  const config = await window.ember.getConfig()

  // Wait for the terminal font before the first fit: measuring cell width against a
  // fallback font produces a wrong cols/rows that only corrects on the next resize.
  await loadFont(config.font.family, config.font.weight, config.font.size)
  await loadFont("Archivo", 400, 13)

  const app = new App(config)
  await app.boot()
}

void boot().catch((err) => {
  console.error('[ember] boot failed', err)
  const pre = document.createElement('pre')
  pre.style.cssText = 'padding:24px;color:#FF6B8B;font:13px/1.6 Consolas,monospace;white-space:pre-wrap'
  pre.textContent = `Ember failed to start:\n\n${(err as Error).stack ?? String(err)}`
  document.body.appendChild(pre)
})
