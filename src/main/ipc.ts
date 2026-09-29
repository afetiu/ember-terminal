import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { TODO_SOURCES } from '../shared/types.js'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { activeGpu } from './gpu.js'
import { CONFIG_DIR, DEFAULT_CONFIG, loadConfig, resolveHome, saveConfig, watchConfig } from './config.js'
import { join } from 'node:path'
import { listProjects } from './projects.js'
import { checkTodos, createNote, deleteNote, installNotesCli, installSkills, listNotes, readNote, readTodo, readTodoArchive, saveNote, todoState, watchNotes, writeTodo, writeTodoArchive, NOTES_DIR } from './notes.js'
import { THEMES } from './themes.js'
import { listFonts } from './fonts.js'
import { gitStatus, killPort, listTasks } from './project.js'
import { VitalsWatcher } from './vitals.js'
import { UsageWatcher } from './usage.js'
import { detectAgents, pingAgent } from './agents.js'
import { agentSpec } from '../shared/agents.js'
import { deskState, haltDesk, isOverlayWindow, onDeskState, overlayState, resumeDesk, setOverlayInteractive, stopDesk, toggleDesk } from './desk.js'
import { allBriefs, onBrief } from './overview.js'
import { clearLegacyState } from './state.js'
import { bridgeEnv, bridgeOrigin, forgetTab, pushFromMain, resolveCmd } from './bridge.js'
import { renderPanelDocument } from './panelDoc.js'
import { watchState } from './transcript.js'
import { cliTurn } from './orchestrator.js'
import { orchEnv, resolveOrchTool } from './bridge.js'
import { randomUUID as orchRunId } from 'node:crypto'
import { askClaude, canAsk, cancelAsk } from './converse.js'
import { createAccount, joinAccount, readAccount, renameDevice, saveAccount } from './remote.js'
import * as maps from './systemMap.js'
import { startLive } from './mapLive.js'
import { dispatch, drain, follow, forgetAll as forgetCrew, forget as forgetTabCrew, onCrewNote, report } from './crew.js'
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
  const broadcast = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      // The cursor overlay is a window too, but not one of ours to talk to this way.
      if (!win.isDestroyed() && !isOverlayWindow(win)) win.webContents.send(channel, payload)
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

  // Computer use: the strip's indicator and Stop switch, and the overlay's pill.
  onDeskState((s) => broadcast('ember:desk:state', s))
  ipcMain.handle('ember:desk:state', () => deskState())
  ipcMain.on('ember:desk:halt', () => haltDesk())
  ipcMain.on('ember:desk:resume', () => resumeDesk())
  ipcMain.on('ember:desk:toggle', () => toggleDesk())
  ipcMain.on('ember:desk:overlay:interactive', (_e, on: boolean) => setOverlayInteractive(on === true))
  ipcMain.handle('ember:desk:overlay:state', () => overlayState())
  app.on('before-quit', () => stopDesk())

  // The overview: what every Claude session last said and is doing.
  ipcMain.handle('ember:overview:all', () => allBriefs())
  onBrief((b) => broadcast('ember:overview:brief', b))

  ipcMain.handle('ember:config', () => loadConfig())

  // `notes` and `note` as commands on every shell's PATH, and the folder watched so a
  // note written from a shell — or by a Claude session, or by Notepad — shows up in an
  // open tab by itself.
  const notesBin = installNotesCli()
  installSkills()
  const unwatchNotes = watchNotes((id) => broadcast('ember:notes:changed', { id }))
  // The Check todos button: the person's own Claude, run once, headless.
  ipcMain.handle('ember:todo:check', () => {
    const t = loadConfig().todo
    const sources = TODO_SOURCES.filter((s) => t[s])
    return checkTodos(notesBin, sources)
  })
  ipcMain.on('ember:cmd:reply', (_e, reqId: string, r: { result: string; error?: string }) => resolveCmd(reqId, r))
  ipcMain.handle('ember:todo:state', () => todoState())
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
      bin: [notesBin],
      env: { EMBER_NOTES_DIR: NOTES_DIR },
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

  // The voice's one tool. It types into the tab's focused pane and reads the answer back
  // off Claude Code's transcript — see `converse.ts` for why that beats calling the API.
  ipcMain.handle('ember:voice:ask', (_e, tabId: string, sessionId: string, question: string) =>
    askClaude(host, tabId, sessionId, question)
  )
  ipcMain.on('ember:voice:cancel', (_e, tabId: string) => cancelAsk(tabId))
  ipcMain.handle('ember:voice:ready', (_e, tabId: string) => canAsk(tabId))
  // What the tab's transcript watcher is looking at — the only window into a
  // pipeline whose every failure mode is silence.
  ipcMain.handle('ember:voice:watch', (_e, tabId: string) => watchState(tabId))

  // The orchestrator's written half. One turn per call: main makes the request because
  // it holds the key, the renderer runs the tools because it holds the sessions.
  // The same agent on the person's own CLI: one headless turn with ember-orch attached.
  // Its tool calls come back through the bridge to the renderer (ember:orch:tool).
  ipcMain.handle('ember:orch:cli', (_e, text: string, recap: string) =>
    cliTurn(text, recap, orchEnv(orchRunId()), (line) => broadcast('ember:orch:progress', line))
  )
  ipcMain.on('ember:orch:toolResult', (_e, reqId: string, result: string) => resolveOrchTool(reqId, String(result ?? '')))

  // This machine's membership of the Ember account. Main owns the file; the renderer owns
  // the link, because the link's whole job is to reach the orchestrator and its tools,
  // which live there.
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

  // The crew: work handed to a session and left running. Distinct from `ask` above,
  // which blocks the call until the turn completes.
  ipcMain.handle('ember:crew:dispatch', (_e, tabId: string, sessionId: string, task: string) =>
    dispatch(host, tabId, sessionId, task)
  )
  ipcMain.handle('ember:crew:report', (_e, tabId: string) => report(tabId))
  ipcMain.handle('ember:crew:drain', (_e, tabId: string) => drain(tabId))
  ipcMain.on('ember:crew:follow', (_e, tabId: string) => follow(tabId))
  ipcMain.on('ember:crew:forget', (_e, tabId: string) => forgetTabCrew(tabId))
  // A session going quiet is the one thing the voice cannot find out by asking.
  onCrewNote((note) => broadcast('ember:crew:note', note))
  app.on('before-quit', () => forgetCrew())

  // The map: projects, their living models, and questions about any part of one.
  const stopMaps = maps.startMaps(broadcast)
  app.on('before-quit', () => stopMaps())
  ipcMain.handle('ember:map:list', () => maps.listProjects())
  ipcMain.handle('ember:map:load', (_e, id: string) => maps.load(id))
  ipcMain.handle('ember:map:create', (_e, input: { name: string; brief: string; pollMinutes?: number }) => {
    const p = maps.createProject(input)
    void maps.build(p.id)
    return p
  })
  ipcMain.handle('ember:map:edit', (_e, id: string, patch: { name?: string; brief?: string; pollMinutes?: number }) => maps.updateProject(id, patch))
  ipcMain.handle('ember:map:remove', (_e, id: string) => maps.deleteProject(id))
  ipcMain.on('ember:map:build', (_e, id: string, rebuild?: boolean) => void maps.build(id, !!rebuild))
  ipcMain.on('ember:map:check', (_e, id: string, force?: boolean) => void maps.check(id, !!force))
  ipcMain.on('ember:map:cancel', (_e, id: string) => maps.cancelJob(id))
  ipcMain.on('ember:map:viewed', (_e, id: string) => maps.markViewed(id))
  ipcMain.on('ember:map:ask', (_e, projectId: string, nodeId: string | null, question: string, askId: string) => maps.ask(projectId, nodeId, question, askId))
  ipcMain.on('ember:map:askCancel', (_e, askId: string) => maps.cancelAsk(askId))
  // A source on the map that is a file: shown in Explorer, never opened or run.
  ipcMain.handle('ember:map:history', (_e, id: string) => maps.listHistory(id))
  ipcMain.handle('ember:map:version', (_e, id: string, v: number) => maps.loadVersion(id, v))
  // Live activity: every Claude session's transcript, read only while a map is open.
  let liveWatchers = 0
  let stopLive: (() => void) | null = null
  ipcMain.on('ember:map:live:watch', (_e, on: boolean) => {
    liveWatchers = Math.max(0, liveWatchers + (on ? 1 : -1))
    if (liveWatchers && !stopLive) stopLive = startLive((s) => broadcast('ember:map:live', s))
    else if (!liveWatchers && stopLive) {
      stopLive()
      stopLive = null
    }
  })
  app.on('before-quit', () => stopLive?.())
  ipcMain.on('ember:map:reveal', (_e, path: string) => {
    if (typeof path === 'string' && existsSync(path)) shell.showItemInFolder(path)
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
