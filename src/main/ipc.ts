import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { activeGpu } from './gpu.js'
import { CONFIG_DIR, DEFAULT_CONFIG, loadConfig, resolveHome, saveConfig, watchConfig } from './config.js'
import { join } from 'node:path'
import { listProjects } from './projects.js'
import { createNote, deleteNote, installNotesCli, installSkills, listNotes, readNote, readTodo, readTodoArchive, saveNote, watchNotes, writeTodo, writeTodoArchive, NOTES_DIR } from './notes.js'
import { THEMES } from './themes.js'
import { listFonts } from './fonts.js'
import { gitStatus, killPort, listTasks } from './project.js'
import { VitalsWatcher } from './vitals.js'
import { UsageWatcher } from './usage.js'
import { Updater } from './update.js'
import { detectAgents, pingAgent } from './agents.js'
import { AGENTS, agentSpec, type AgentId } from '../shared/agents.js'
import { clearLegacyState } from './state.js'
import { bridgeEnv, bridgeOrigin, docStatus, forgetTab, hostDoc, markCanvasTab, pushFromMain, resolveCmd, showFile } from './bridge.js'
import { registerCanvas } from './canvas.js'
import { renderPanelDocument } from './panelDoc.js'
import { createAccount, joinAccount, readAccount, renameDevice, saveAccount } from './remote.js'
import type { PtyHost } from './pty/PtyHost.js'
import type {
  EmberConfig,
  PanelPush,
  SpawnRequest,
  SpawnResult,
} from '../shared/types.js'

/**
 * @param onConfigChange runs alongside the renderer broadcast, for the parts of a
 * config that only main can apply — the window's own material and alpha.
 */
export function registerIpc(host: PtyHost, onConfigChange?: (config: EmberConfig) => void): void {
  // Loom tabs: the transcript feed, media and page annotations for the canvas.
  registerCanvas({ origin: bridgeOrigin, hostDoc, markCanvasTab })
  // "Ask about this" from the canvas: one short answer, in a run of its own, so the session's
  // turn is not interrupted and its context is not spent. Read-only.
  ipcMain.handle('ember:canvas:sideAsk', async (_e, question: string, about: string, source: string, cwd?: string) => {
    const prompt =
      `Answer the user's question about one object on their screen, briefly: a few sentences or a short list, ` +
      `plain markdown, no preamble. You may read files if it helps, but do not change anything.\n\n` +
      `The object: ${about}\n${source ? `Its content:\n${String(source).slice(0, 12000)}\n` : ''}\nThe question: ${question}`
    const { runAgent } = await import('./agents.js')
    return runAgent(prompt, { timeoutMs: 120_000, ...(cwd ? { cwd } : {}) }).done
  })
  ipcMain.on('ember:canvas:docStatus', (_e, id: string, status: { ok: boolean; error: string; repaired: boolean }) => docStatus(id, status))
  ipcMain.handle('ember:canvas:showFile', (_e, tabId: string, path: string, title?: string) => {
    try {
      return showFile(tabId, path, title)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  const broadcast = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }

  host.onData((sessionId, data) => broadcast('ember:data', { sessionId, data }))
  host.onExit((sessionId, exitCode, signal) => broadcast('ember:exit', { sessionId, exitCode, signal }))

  watchConfig((config) => {
    broadcast('ember:config:changed', config)
    onConfigChange?.(config)
  })
  // Sweep the files the old restore feature left behind, once, on the way in.
  clearLegacyState()

  ipcMain.handle('ember:projects', () => listProjects())
  ipcMain.handle('ember:themes', () => THEMES)
  ipcMain.handle('ember:fonts', () => listFonts())
  ipcMain.handle('ember:config:defaults', () => DEFAULT_CONFIG)
  ipcMain.on('ember:config:save', (_e, next) => saveConfig(next))
  ipcMain.handle('ember:git', (_e, cwd: string) => gitStatus(cwd))
  ipcMain.handle('ember:tasks', (_e, cwd: string) => listTasks(cwd))
  ipcMain.handle('ember:killPort', (_e, port: number) => killPort(port))

  const vitals = new VitalsWatcher((s) => broadcast('ember:vitals:state', s))
  vitals.start()
  app.on('before-quit', () => vitals.dispose())
  ipcMain.handle('ember:vitals:state', () => vitals.state)

  // The plan's rate limits, beside CPU and memory. Polled only while the setting is on.
  const usage = new UsageWatcher((u) => broadcast('ember:usage:state', u))
  usage.setEnabled(loadConfig().claude.usageLimits)
  watchConfig((config) => usage.setEnabled(config.claude.usageLimits))
  app.on('before-quit', () => usage.dispose())
  ipcMain.handle('ember:usage:state', () => usage.state)
  ipcMain.handle('ember:agents:detect', (_e, withVersions: boolean) => detectAgents(withVersions))
  ipcMain.handle('ember:agents:ping', (_e, id: string) => pingAgent(agentSpec(id).id))
  ipcMain.on('ember:usage:refresh', () => usage.refresh())

  // Ember's own updates: checked from its GitHub releases, installed on request.
  const updater = new Updater((s) => broadcast('ember:update:state', s))
  app.on('before-quit', () => updater.dispose())
  ipcMain.handle('ember:update:state', () => updater.state)
  ipcMain.handle('ember:claude:fullscreen-why', () => claudeFullscreenWhy())
  ipcMain.handle('ember:update:check', () => updater.check())
  ipcMain.on('ember:update:install', () => void updater.install())

  ipcMain.handle('ember:config', () => loadConfig())

  // `notes` and `note` as commands on every shell's PATH, and the folder watched so a
  // note written from a shell — or by a Claude session, or by Notepad — shows up in an
  // open tab by itself.
  const notesBin = installNotesCli()
  installSkills()
  const unwatchNotes = watchNotes((id) => broadcast('ember:notes:changed', { id }))
  ipcMain.on('ember:cmd:reply', (_e, reqId: string, r: { result: string; error?: string }) => resolveCmd(reqId, r))
  ipcMain.handle('ember:todo:read', () => readTodo())
  ipcMain.handle('ember:todo:write', (_e, body: string) => writeTodo(body))
  ipcMain.handle('ember:todo:archive:read', () => readTodoArchive())
  ipcMain.handle('ember:todo:archive:write', (_e, body: string) => writeTodoArchive(body))
  app.on('before-quit', () => unwatchNotes())

  ipcMain.handle('ember:spawn', (_e, req: SpawnRequest): SpawnResult => {
    const config = loadConfig()
    const profile = config.profiles.find((p) => p.id === req.profileId) ?? config.profiles[0]
    if (!profile) throw new Error('No shell profiles configured')
    // Every tab gets bridge coordinates: that is what `ember`, `notes`, `todo` and the
    // panel MCP server use to find the app from inside the shell.
    const panel = req.tabId ? bridgeEnv(req.tabId) : undefined
    const session = host.spawn({
      sessionId: req.sessionId,
      profile,
      cols: req.cols,
      rows: req.rows,
      cwd: resolveHome(req.cwd ?? profile.cwd),
      shellIntegration: config.shellIntegration,
      // Only a known agent's own command, never free text from the renderer.
      ...(req.agent && req.agent in AGENTS
        ? {
            startup:
              AGENTS[req.agent as AgentId].bin +
              // Probes only: flags for a real run (`--model haiku`), from main's own environment, never the renderer.
              (req.agent === 'claude' && process.env['EMBER_CLAUDE_ARGS'] && /^[\w\s=.-]+$/.test(process.env['EMBER_CLAUDE_ARGS']) ? ` ${process.env['EMBER_CLAUDE_ARGS']}` : ''),
          }
        : {}),
      bin: [notesBin],
      // A Loom tab says so to everything it starts: the panel MCP server reads it and
      // describes a canvas instead of a side panel.
      env: { EMBER_NOTES_DIR: NOTES_DIR, ...(req.surface === 'canvas' ? { EMBER_SURFACE: 'canvas' } : {}) },
      ...(panel && Object.keys(panel).length ? { panel } : {}),
    })
    return { sessionId: session.sessionId, pid: session.pid, shell: session.shell }
  })

  ipcMain.handle('ember:panel:origin', () => bridgeOrigin())
  ipcMain.on('ember:panel:forget', (_e, tabId: string) => forgetTab(tabId))

  // Notes are files in a folder the user can browse, so main does no caching and holds no
  // index: every call reads the directory. At the scale of a notes folder that is cheaper
  // than any cache would be, and it means a note edited in Notepad is simply there.
  ipcMain.handle('ember:notes:list', () => listNotes())
  ipcMain.handle('ember:notes:read', (_e, id: string) => readNote(id))
  ipcMain.handle('ember:notes:save', (_e, id: string, body: string) => saveNote(id, body))
  ipcMain.handle('ember:notes:create', (_e, body?: string) => createNote(body ?? ''))
  ipcMain.handle('ember:notes:remove', (_e, id: string) => deleteNote(id))
  ipcMain.handle('ember:notes:dir', () => NOTES_DIR)
  ipcMain.on('ember:notes:reveal', (_e, id?: string) => {
    if (id) shell.showItemInFolder(join(NOTES_DIR, id))
    else void shell.openPath(NOTES_DIR)
  })

  // Render a panel document for the phone. Done here because this is where the renderer
  // lives, so the phone shows exactly what the desk shows rather than a second renderer
  // built over there to drift away from it.
  ipcMain.handle('ember:panel:render', (_e, push: PanelPush) => renderPanelDocument(push, 'phone'))

  ipcMain.handle('ember:remote:account', () => readAccount())
  ipcMain.handle('ember:remote:create', () => createAccount())
  ipcMain.handle('ember:remote:join', (_e, relay: string, key: string) => joinAccount(relay, key))
  ipcMain.handle('ember:remote:rename', (_e, name: string) => renameDevice(name))
  ipcMain.handle('ember:remote:leave', () => {
    // Leaving takes this machine off the roster on every device. It does not revoke the
    // account — the key is on the other machines too, and rotating it means visiting them.
    saveAccount(null)
    return true
  })

  // Main's own responsiveness, for scripts/probe-latency.mjs. Every keystroke and every
  // echo crosses this process, so a stall here is felt in every tab at once and looks,
  // from the renderer, exactly like a slow shell. The histogram is reset on read so a
  // probe sees the window since it last asked.
  const loop = monitorEventLoopDelay({ resolution: 5 })
  loop.enable()
  ipcMain.handle('ember:diag:loop', () => {
    const ms = (ns: number) => Math.round(ns / 1e4) / 100
    const out = { max: ms(loop.max), p99: ms(loop.percentile(99)), mean: ms(loop.mean), pty: host.stats?.() ?? {} }
    loop.reset()
    return out
  })

  ipcMain.handle('ember:diag:pushPanel', (_e, body: Record<string, unknown>) => pushFromMain(body))
  ipcMain.handle('ember:diag:gpu', () => activeGpu())
  // What the renderer's watchdogs saw, kept on disk so it survives the window and can
  // be read with `ember diag`. Capped: a watchdog that fires every tick must not fill a disk.
  ipcMain.on('ember:diag:log', (_e, entry: Record<string, unknown>) => {
    try {
      const file = join(CONFIG_DIR, 'diag.log')
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'
      if (existsSync(file) && statSync(file).size > 400_000) {
        const keep = readFileSync(file, 'utf8').split('\n').slice(-500).join('\n')
        writeFileSync(file, keep + '\n', 'utf8')
      }
      appendFileSync(file, line, 'utf8')
    } catch {
      /* the log is best effort */
    }
  })


  ipcMain.on('ember:write', (_e, sessionId: string, data: string) => host.write(sessionId, data))
  ipcMain.on('ember:resize', (_e, sessionId: string, cols: number, rows: number) => host.resize(sessionId, cols, rows))
  ipcMain.on('ember:kill', (_e, sessionId: string) => host.kill(sessionId))
  ipcMain.on('ember:ack', (_e, sessionId: string, chars: number) => host.ack(sessionId, chars))

  const windowOf = (e: Electron.IpcMainEvent) => BrowserWindow.fromWebContents(e.sender)
  ipcMain.on('ember:win:minimize', (e) => windowOf(e)?.minimize())
  ipcMain.on('ember:win:toggleMaximize', (e) => {
    const win = windowOf(e)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('ember:win:close', (e) => windowOf(e)?.close())
}

/**
 * What on this machine asks Claude Code for its full-screen renderer, which leaves no live
 * area for the canvas's box. Ember passes `tui: "default"` and clears CLAUDE_CODE_NO_FLICKER,
 * but a managed setting or an older Claude Code can still win; this says which, plainly.
 */
function claudeFullscreenWhy(): string {
  const found: string[] = []
  if (process.env['CLAUDE_CODE_NO_FLICKER']) found.push(`CLAUDE_CODE_NO_FLICKER=${process.env['CLAUDE_CODE_NO_FLICKER']} is set in Windows (Ember clears it in its tabs)`)
  // Ember's own settings outrank the person's settings files; a managed one outranks Ember's.
  const files = ['C:/ProgramData/ClaudeCode/managed-settings.json', 'C:/Program Files/ClaudeCode/managed-settings.json']
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8')) as { tui?: string; env?: Record<string, string> }
      if (j.tui === 'fullscreen') found.push(`${f} has "tui": "fullscreen"`)
      if (j.env?.['CLAUDE_CODE_NO_FLICKER']) found.push(`${f} sets CLAUDE_CODE_NO_FLICKER in its env`)
    } catch {
      /* not there, or not JSON: nothing to report */
    }
  }
  return found.join('; ')
}

