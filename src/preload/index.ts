import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { homedir } from 'node:os'
import type {
  NoteMeta,
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
  UpdateState,
  CanvasFeed,
  CanvasMedia,
  CanvasAnnotate,
  CanvasAnnotateResult,
  CanvasSteps, EmberCost,
  ClaudeEvent,
  NativeTabState,
  ClaudeStartResult } from '../shared/types.js'

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
  stopChildren: (sessionId) => ipcRenderer.invoke('ember:stopChildren', sessionId) as Promise<number>,
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
  canvas: {
    watch: (tabId: string) => ipcRenderer.invoke('ember:canvas:watch', tabId) as Promise<boolean>,
    unwatch: (tabId: string) => ipcRenderer.send('ember:canvas:unwatch', tabId),
    drain: (tabId: string) => ipcRenderer.invoke('ember:canvas:drain', tabId) as Promise<boolean>,
    onFeed: (cb) => on<CanvasFeed>('ember:canvas:feed', cb),
    media: (path: string) =>
      ipcRenderer.invoke('ember:canvas:media', path) as Promise<
        { src: string; kind: 'image' | 'video' | 'audio'; name: string } | { error: string }
      >,
    doc: (tabId, title, format, content) => ipcRenderer.invoke('ember:canvas:doc', tabId, title, format, content) as Promise<string>,
    docStatus: (id, status) => ipcRenderer.send('ember:canvas:docStatus', id, status),
    sideAsk: (question, about, source, cwd) =>
      ipcRenderer.invoke('ember:canvas:sideAsk', question, about, source, cwd) as Promise<{ ok: boolean; text: string; error?: string }>,
    showFile: (tabId, path, title) => ipcRenderer.invoke('ember:canvas:showFile', tabId, path, title) as Promise<{ ok?: boolean; title?: string; error?: string }>,
    onMedia: (cb) => on<CanvasMedia>('ember:canvas:media', cb),
    onAnnotate: (cb) => on<CanvasAnnotate>('ember:canvas:annotate', cb),
    onPoint: (cb) => on<{ tabId: string; reqId: string; object: string; text: string; say: string; step?: number; steps?: number }>('ember:canvas:point', cb),
    pointed: (reqId, result) => ipcRenderer.send('ember:canvas:pointed', reqId, result),
    annotated: (reqId: string, result: CanvasAnnotateResult) => ipcRenderer.send('ember:canvas:annotated', reqId, result),
    onSteps: (cb) => on<CanvasSteps>('ember:canvas:steps', cb),
    onCost: (cb) => on<EmberCost>('ember:canvas:cost', cb),
    tabAgent: (tabId, agent, cwd, since) => ipcRenderer.send('ember:canvas:tabAgent', tabId, agent, cwd, since),
    handoff: (text) => ipcRenderer.invoke('ember:canvas:handoff', text) as Promise<string>,
    onAgent: (cb) => on<{ tabId: string; agentId: string; action: string; at: number }>('ember:canvas:agent', cb),
    screen: (tabId, items) => ipcRenderer.send('ember:canvas:screen', tabId, items),
  },
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
  },
  brain: {
    status: () => ipcRenderer.invoke('ember:brain:status'),
    sync: () => ipcRenderer.invoke('ember:brain:sync'),
  },
  // This machine's place in the Ember account. The key crosses into the renderer because
  // the link lives there, next to the phone host it exists to reach.
  remote: {
    account: () => ipcRenderer.invoke('ember:remote:account') as Promise<Account | null>,
    create: () => ipcRenderer.invoke('ember:remote:create') as Promise<Account>,
    join: (relay: string, key: string) => ipcRenderer.invoke('ember:remote:join', relay, key) as Promise<Account>,
    rename: (name: string) => ipcRenderer.invoke('ember:remote:rename', name) as Promise<Account | null>,
    leave: () => ipcRenderer.invoke('ember:remote:leave') as Promise<boolean>,
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
    agentsWorking: (on) => ipcRenderer.send('ember:desk:agentsWorking', on === true),
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
  update: {
    state: () => ipcRenderer.invoke('ember:update:state') as Promise<UpdateState>,
    check: () => ipcRenderer.invoke('ember:update:check') as Promise<UpdateState>,
    install: () => ipcRenderer.send('ember:update:install'),
    onState: (cb) => on<UpdateState>('ember:update:state', cb),
  },
  claude: {
    onStatus: (cb) => on<ClaudeStatus>('ember:claude:status', cb),
    start: (tabId, opts) => ipcRenderer.invoke('ember:claude:start', tabId, opts) as Promise<ClaudeStartResult>,
    send: (tabId, text, images, opts) => ipcRenderer.send('ember:claude:send', tabId, text, images, opts),
    control: (tabId, request) => ipcRenderer.invoke('ember:claude:control', tabId, request) as Promise<{ ok: boolean; response?: Record<string, unknown>; error?: string }>,
    interrupt: (tabId) => ipcRenderer.invoke('ember:claude:interrupt', tabId) as Promise<{ ok: boolean; error?: string }>,
    answer: (tabId, requestId, response) => ipcRenderer.send('ember:claude:answer', tabId, requestId, response),
    stop: (tabId) => ipcRenderer.invoke('ember:claude:stop', tabId) as Promise<void>,
    onEvent: (cb) => on<ClaudeEvent>('ember:claude:event', cb),
    saveTabs: (tabs) => ipcRenderer.send('ember:claude:saveTabs', tabs),
    savedTabs: () => ipcRenderer.invoke('ember:claude:savedTabs') as Promise<NativeTabState[]>,
    boundSession: (tabId) => ipcRenderer.invoke('ember:claude:bound', tabId) as Promise<string>,
    latestSession: (cwd, since) => ipcRenderer.invoke('ember:claude:latest', cwd, since) as Promise<string>,
  },
  window: {
    minimize: () => ipcRenderer.send('ember:win:minimize'),
    toggleMaximize: () => ipcRenderer.send('ember:win:toggleMaximize'),
    close: () => ipcRenderer.send('ember:win:close'),
    onMaximizeChange: (cb) => on<boolean>('ember:win:maximized', cb),
  },
  platform: {
    homedir: homedir(),
    // A dropped File no longer carries .path; this is the supported way to get it.
    pathForFile: (file: File) => webUtils.getPathForFile(file),
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
