import { contextBridge, ipcRenderer } from 'electron'
import { homedir } from 'node:os'
import type {
  AskResult,
  CrewNote,
  NoteMeta,
  CrewReport,
  RealtimeAuth,
  TurnMessage,
  TurnResult,
  PtyDataEvent,
  PtyExitEvent,
  SpawnRequest,
  SpawnResult,
  EmberBridge,
  EmberConfig,
  FontOption,
  ProjectEntry,
  GitStatus,
  PanelAct,
  PanelPush,
  Account,
  TaskEntry,
  ThemeConfig,
  VitalsState,
  DeskState,
  ClaudeStatus,
  ClaudeUsage,
  SessionBrief,
  MapAskEvent,
  MapBundle,
  MapJob,
  MapProject,
  MapSummary,
  MapHistoryEntry,
  MapLiveSession,
  MapModel,
} from '../shared/types.js'

/** Subscribe helper that returns an unsubscribe function and strips the IpcRendererEvent. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const bridge: EmberBridge = {
  getConfig: () => ipcRenderer.invoke('ember:config') as Promise<EmberConfig>,
  spawn: (req: SpawnRequest) => ipcRenderer.invoke('ember:spawn', req) as Promise<SpawnResult>,
  write: (sessionId, data) => ipcRenderer.send('ember:write', sessionId, data),
  resize: (sessionId, cols, rows) => ipcRenderer.send('ember:resize', sessionId, cols, rows),
  kill: (sessionId) => ipcRenderer.send('ember:kill', sessionId),
  ack: (sessionId, chars) => ipcRenderer.send('ember:ack', sessionId, chars),
  onData: (cb) => on<PtyDataEvent>('ember:data', cb),
  onExit: (cb) => on<PtyExitEvent>('ember:exit', cb),
  onConfigChange: (cb) => on<EmberConfig>('ember:config:changed', cb),
  listProjects: () => ipcRenderer.invoke('ember:projects') as Promise<ProjectEntry[]>,
  listThemes: () => ipcRenderer.invoke('ember:themes') as Promise<ThemeConfig[]>,
  listFonts: () => ipcRenderer.invoke('ember:fonts') as Promise<FontOption[]>,
  defaultConfig: () => ipcRenderer.invoke('ember:config:defaults') as Promise<EmberConfig>,
  saveConfig: (next) => ipcRenderer.send('ember:config:save', next),
  gitStatus: (cwd) => ipcRenderer.invoke('ember:git', cwd) as Promise<GitStatus | null>,
  listTasks: (cwd) => ipcRenderer.invoke('ember:tasks', cwd) as Promise<TaskEntry[]>,
  killPort: (port) => ipcRenderer.invoke('ember:killPort', port) as Promise<{ killed: number[]; error?: string }>,
  panel: {
    origin: () => ipcRenderer.invoke('ember:panel:origin') as Promise<string>,
    onPush: (cb) => on<PanelPush>('ember:panel:push', cb),
    onClear: (cb) => on<{ tabId: string }>('ember:panel:clear', cb),
    onAct: (cb) => on<PanelAct>('ember:panel:act', cb),
    forget: (tabId) => ipcRenderer.send('ember:panel:forget', tabId),
    render: (push: PanelPush) => ipcRenderer.invoke('ember:panel:render', push) as Promise<string>,
  },
  notes: {
    list: () => ipcRenderer.invoke('ember:notes:list') as Promise<NoteMeta[]>,
    read: (id: string) => ipcRenderer.invoke('ember:notes:read', id) as Promise<string | null>,
    save: (id: string, body: string) =>
      ipcRenderer.invoke('ember:notes:save', id, body) as Promise<{ ok: boolean; id: string; error?: string }>,
    create: (body?: string) => ipcRenderer.invoke('ember:notes:create', body) as Promise<NoteMeta | null>,
    remove: (id: string) => ipcRenderer.invoke('ember:notes:remove', id) as Promise<boolean>,
    reveal: (id?: string) => ipcRenderer.send('ember:notes:reveal', id),
    dir: () => ipcRenderer.invoke('ember:notes:dir') as Promise<string>,
    onOpen: (cb) => on<{ mode?: 'list' | 'new' | 'open' | 'todo'; text?: string; id?: string; tabId?: string }>('ember:notes:open', cb),
    onChanged: (cb) => on<{ id: string; was?: string; deleted?: boolean }>('ember:notes:changed', cb),
    checkTodos: () =>
      ipcRenderer.invoke('ember:todo:check') as Promise<{ ok: boolean; output: string; error?: string; lastCheckedAt?: string }>,
    todoState: () => ipcRenderer.invoke('ember:todo:state') as Promise<{ lastCheckedAt?: string; sources?: string[] }>,
  },
  map: {
    list: () => ipcRenderer.invoke('ember:map:list') as Promise<MapSummary[]>,
    load: (id: string) => ipcRenderer.invoke('ember:map:load', id) as Promise<MapBundle | null>,
    create: (input: { name: string; brief: string; pollMinutes?: number }) => ipcRenderer.invoke('ember:map:create', input) as Promise<MapProject>,
    edit: (id: string, patch: { name?: string; brief?: string; pollMinutes?: number }) =>
      ipcRenderer.invoke('ember:map:edit', id, patch) as Promise<MapProject | null>,
    remove: (id: string) => ipcRenderer.invoke('ember:map:remove', id) as Promise<boolean>,
    build: (id: string, rebuild?: boolean) => ipcRenderer.send('ember:map:build', id, rebuild),
    check: (id: string, force?: boolean) => ipcRenderer.send('ember:map:check', id, force),
    cancel: (id: string) => ipcRenderer.send('ember:map:cancel', id),
    viewed: (id: string) => ipcRenderer.send('ember:map:viewed', id),
    ask: (projectId: string, nodeId: string | null, question: string, askId: string) =>
      ipcRenderer.send('ember:map:ask', projectId, nodeId, question, askId),
    cancelAsk: (askId: string) => ipcRenderer.send('ember:map:askCancel', askId),
    reveal: (path: string) => ipcRenderer.send('ember:map:reveal', path),
    history: (id: string) => ipcRenderer.invoke('ember:map:history', id) as Promise<MapHistoryEntry[]>,
    version: (id: string, version: number) => ipcRenderer.invoke('ember:map:version', id, version) as Promise<MapModel | null>,
    watchLive: (on: boolean) => ipcRenderer.send('ember:map:live:watch', on),
    onLive: (cb) => on<MapLiveSession[]>('ember:map:live', cb),
    onChanged: (cb) => on<{ id: string; deleted?: boolean }>('ember:map:changed', cb),
    onJob: (cb) => on<{ id: string; job: MapJob | null }>('ember:map:job', cb),
    onAsk: (cb) => on<MapAskEvent>('ember:map:ask', cb),
  },
  voice: {
    secret: (voice: string, model: string) =>
      ipcRenderer.invoke('ember:voice:secret', voice, model) as Promise<RealtimeAuth>,
    configured: () =>
      ipcRenderer.invoke('ember:voice:configured') as Promise<{
        configured: boolean
        path: string
        hint: string
      }>,
    setKey: (key: string) =>
      ipcRenderer.invoke('ember:voice:setKey', key) as Promise<{
        ok: boolean
        configured: boolean
        hint: string
      }>,
    onConfigured: (cb) => on<{ configured: boolean; path: string; hint: string }>('ember:voice:configured:changed', cb),
    ask: (tabId: string, sessionId: string, question: string) =>
      ipcRenderer.invoke('ember:voice:ask', tabId, sessionId, question) as Promise<AskResult>,
    cancel: (tabId: string) => ipcRenderer.send('ember:voice:cancel', tabId),
    ready: (tabId: string) => ipcRenderer.invoke('ember:voice:ready', tabId) as Promise<boolean>,
    watch: (tabId: string) => ipcRenderer.invoke('ember:voice:watch', tabId) as Promise<unknown>,
  },
  secret: {
    status: (provider: 'openai' | 'anthropic') =>
      ipcRenderer.invoke('ember:secret:status', provider) as Promise<{
        configured: boolean
        path: string
        hint: string
      }>,
    set: (provider: 'openai' | 'anthropic', key: string) =>
      ipcRenderer.invoke('ember:secret:set', provider, key) as Promise<{
        ok: boolean
        configured: boolean
        hint: string
      }>,
  },
  brain: {
    speak: (tabId: string, question: string, live: string) =>
      ipcRenderer.invoke('ember:brain:speak', tabId, question, live) as Promise<{
        ok: boolean
        text: string
        error?: string
      }>,
    configured: () => ipcRenderer.invoke('ember:brain:configured') as Promise<boolean>,
    forget: (tabId?: string) => ipcRenderer.send('ember:brain:forget', tabId),
  },
  orch: {
    turn: (history: TurnMessage[], model: string) =>
      ipcRenderer.invoke('ember:orch:turn', history, model) as Promise<TurnResult>,
    cli: (text: string, recap: string) => ipcRenderer.invoke('ember:orch:cli', text, recap),
    onTool: (cb) => on<{ reqId: string; run: string; name: string; args: Record<string, unknown> }>('ember:orch:tool', cb),
    toolResult: (reqId: string, result: string) => ipcRenderer.send('ember:orch:toolResult', reqId, result),
    onProgress: (cb) => on<string>('ember:orch:progress', cb),
  },
  // This machine's place in the Ember account. The key crosses into the renderer because
  // the link lives there, next to the orchestrator it exists to reach.
  remote: {
    account: () => ipcRenderer.invoke('ember:remote:account') as Promise<Account | null>,
    create: () => ipcRenderer.invoke('ember:remote:create') as Promise<Account>,
    join: (relay: string, key: string) => ipcRenderer.invoke('ember:remote:join', relay, key) as Promise<Account>,
    rename: (name: string) => ipcRenderer.invoke('ember:remote:rename', name) as Promise<Account | null>,
    leave: () => ipcRenderer.invoke('ember:remote:leave') as Promise<boolean>,
  },
  crew: {
    dispatch: (tabId: string, sessionId: string, task: string) =>
      ipcRenderer.invoke('ember:crew:dispatch', tabId, sessionId, task) as Promise<{ ok: boolean; error?: string }>,
    report: (tabId: string) => ipcRenderer.invoke('ember:crew:report', tabId) as Promise<CrewReport | null>,
    drain: (tabId: string) => ipcRenderer.invoke('ember:crew:drain', tabId) as Promise<string>,
    follow: (tabId: string) => ipcRenderer.send('ember:crew:follow', tabId),
    forget: (tabId: string) => ipcRenderer.send('ember:crew:forget', tabId),
    onNote: (cb) => on<CrewNote>('ember:crew:note', cb),
  },
  vitals: {
    state: () => ipcRenderer.invoke('ember:vitals:state') as Promise<VitalsState>,
    onState: (cb) => on<VitalsState>('ember:vitals:state', cb),
  },
  desk: {
    state: () => ipcRenderer.invoke('ember:desk:state') as Promise<DeskState>,
    halt: () => ipcRenderer.send('ember:desk:halt'),
    resume: () => ipcRenderer.send('ember:desk:resume'),
    onState: (cb) => on<DeskState>('ember:desk:state', cb),
  },
  agents: {
    detect: (withVersions?: boolean) => ipcRenderer.invoke('ember:agents:detect', !!withVersions),
    ping: (id: string) => ipcRenderer.invoke('ember:agents:ping', id),
  },
  usage: {
    state: () => ipcRenderer.invoke('ember:usage:state') as Promise<ClaudeUsage>,
    refresh: () => ipcRenderer.send('ember:usage:refresh'),
    onState: (cb) => on<ClaudeUsage>('ember:usage:state', cb),
  },
  claude: {
    onStatus: (cb) => on<ClaudeStatus>('ember:claude:status', cb),
  },
  overview: {
    all: () => ipcRenderer.invoke('ember:overview:all') as Promise<SessionBrief[]>,
    onBrief: (cb) => on<SessionBrief>('ember:overview:brief', cb),
  },
  window: {
    minimize: () => ipcRenderer.send('ember:win:minimize'),
    toggleMaximize: () => ipcRenderer.send('ember:win:toggleMaximize'),
    close: () => ipcRenderer.send('ember:win:close'),
    onMaximizeChange: (cb) => on<boolean>('ember:win:maximized', cb),
  },
  platform: {
    homedir: homedir(),
  },
  cmd: {
    onRun: (cb) => on<{ reqId: string; words: string[]; tabId: string }>('ember:cmd', cb),
    reply: (reqId, r) => ipcRenderer.send('ember:cmd:reply', reqId, r),
  },
  todo: {
    read: () => ipcRenderer.invoke('ember:todo:read') as Promise<string>,
    write: (body: string) => ipcRenderer.invoke('ember:todo:write', body) as Promise<boolean>,
    readArchive: () => ipcRenderer.invoke('ember:todo:archive:read') as Promise<string>,
    writeArchive: (body: string) => ipcRenderer.invoke('ember:todo:archive:write', body) as Promise<boolean>,
  },
  diag: {
    log: (entry: Record<string, unknown>) => ipcRenderer.send('ember:diag:log', entry),
    loop: () => ipcRenderer.invoke('ember:diag:loop') as Promise<EmberBridge['diag']['loop'] extends () => Promise<infer T> ? T : never>,
    pushPanel: (body) => ipcRenderer.invoke('ember:diag:pushPanel', body) as Promise<{ ok: boolean; id?: string; error?: string }>,
    gpu: () => ipcRenderer.invoke('ember:diag:gpu') as Promise<string>,
  },
}

contextBridge.exposeInMainWorld('ember', bridge)
