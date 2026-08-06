import React, { useEffect, useRef, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import './style.css'

type AuthMode = 'account' | 'apiKey'
type ApiProvider = 'openai' | 'minimax' | 'deepseek' | 'custom'
type Mode = 'detail' | 'new' | 'edit'
type ActiveMenu = 'profiles' | 'resources' | 'settings' | 'about'
type ProxyProtocol = 'http' | 'socks5'
type Theme = 'light' | 'dark'
type ConfirmIntent = 'danger' | 'warning'
type NoticeTone = 'success' | 'info' | 'error'

type Notice = {
  id: number
  tone: NoticeTone
  title: string
  detail?: string
  duration?: number
}

type ConfirmRequest = {
  title: string
  body: string
  confirmLabel: string
  intent: ConfirmIntent
  requireText?: string
  requireTextLabel?: string
  details?: string[]
  onConfirm: () => Promise<void> | void
}

const API_PROVIDER_PRESETS: Record<ApiProvider, { label: string; baseUrl: string; routeEnabled: boolean; model: string; hint: string }> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    routeEnabled: false,
    model: 'gpt-5.5',
    hint: '官方 OpenAI API，不需要第三方路由。',
  },
  minimax: {
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    routeEnabled: true,
    model: 'MiniMax-M1',
    hint: '预填 MiniMax OpenAI-compatible 地址。',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    routeEnabled: true,
    model: 'deepseek-v4-flash',
    hint: '预填 DeepSeek OpenAI-compatible 地址。',
  },
  custom: {
    label: '自定义',
    baseUrl: '',
    routeEnabled: true,
    model: '',
    hint: '适合其他 OpenAI-compatible 服务。',
  },
}

type Profile = {
  id: string
  name: string
  homePath: string
  authMode: AuthMode
  apiKey?: string
  apiProvider?: ApiProvider
  apiBaseUrl?: string
  apiRouteEnabled: boolean
  apiRouteModel?: string
  managed: boolean
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
}

type AppSettings = {
  codexAppId: string
  envKey: string
  deleteOpenAiApiKeyBeforeLaunch: boolean
  proxyEnabled: boolean
  proxyProtocol: ProxyProtocol
  proxyHost: string
  proxyPort: string
  launchAtStartup: boolean
  taskWidgetEnabled: boolean
  theme: Theme
}

type UpdateInfo = {
  currentVersion: string
  latestVersion?: string
  releaseDate?: string
  notes?: string
  available: boolean
}

type AppState = {
  profiles: Profile[]
  settings: AppSettings
  activeProfileId?: string
  currentCodexHome?: string
}

type ProfileInspection = {
  exists: boolean
  hasAuthJson: boolean
  hasConfigToml: boolean
  fileCount: number
}

type ConnectionTestResult = {
  ok: boolean
  status: string
  endpoint: string
}

type SharedResources = {
  agentsPath: string
  agentsContent: string
  agentsUpdatedAt?: string | null
  skillsPaths: string[]
  skills: Array<{
    name: string
    version?: string | null
    path: string
    source: string
    shared: boolean
    description?: string | null
    managed: boolean
    sourceType?: string | null
    sourceLabel?: string | null
    canUpdate: boolean
    updatedAt?: string | null
    usageCount: number
    lastUsedAt?: string | null
  }>
}

type SkillImportResult = {
  imported: number
  skipped: number
}

type SharedPlugins = {
  marketplacePath: string
  plugins: Array<{
    name: string
    version: string
    path: string
    syncedProfiles: number
    totalProfiles: number
    managed: boolean
    sourceType?: string | null
    sourceLabel?: string | null
    canUpdate: boolean
    updatedAt?: string | null
    usageCount: number
    lastUsedAt?: string | null
  }>
}

type ResourceKind = 'skill' | 'plugin'

type ResourceOperationResult = {
  succeeded: string[]
  skipped: string[]
  failed: string[]
  profileErrors: string[]
}

type ResourceUpdateCheck = {
  name: string
  updateAvailable: boolean
  currentVersion?: string | null
  latestVersion?: string | null
}

type PluginSyncResult = {
  imported: number
  updated: number
  skipped: number
  conflicts: string[]
  profileErrors: string[]
}

type AutomaticResourceSyncResult = {
  skills: SkillImportResult
  plugins: PluginSyncResult
}

function formatResourceTime(value?: string | null) {
  return value ? new Date(value).toLocaleString() : '未知'
}

type CodexInstance = {
  profileId: string
  profileName: string
  pid: number
  startedAt: string
}

type TaskStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'unknown'

type MonitoredTask = {
  id: string
  profileId: string
  profileName: string
  title: string
  summary?: string
  status: TaskStatus
  waitingKind?: 'choice' | 'reply' | 'approval'
  startedAt: string
  updatedAt: string
}

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  running: '运行中',
  waiting: '等待处理',
  completed: '已完成',
  failed: '执行失败',
  unknown: '状态未知',
}

const WAITING_KIND_LABEL = {
  choice: '等待选择',
  reply: '等待回复',
  approval: '等待授权',
} as const

function taskStatusLabel(task: MonitoredTask) {
  return task.status === 'waiting' && task.waitingKind ? WAITING_KIND_LABEL[task.waitingKind] : TASK_STATUS_LABEL[task.status]
}

function taskStatusIcon(status: TaskStatus) {
  if (status === 'completed') return '✓'
  if (status === 'failed') return '!'
  if (status === 'waiting') return '…'
  return '↻'
}

function elapsed(startedAt: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}

function TaskWidget() {
  const [tasks, setTasks] = useState<MonitoredTask[]>([])
  const [collapsed, setCollapsed] = useState(localStorage.getItem('task-widget-collapsed') === 'true')
  const [now, setNow] = useState(Date.now())
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [showAllRecent, setShowAllRecent] = useState(false)
  const initialized = useRef(false)

  useEffect(() => {
    document.documentElement.dataset.surface = 'task-widget'
    invoke<AppState>('get_app_state')
      .then((appState) => { document.documentElement.dataset.theme = appState.settings.theme || 'light' })
      .catch(() => undefined)
    let cancelled = false
    let refreshTimer = 0
    async function refresh() {
      try {
        const next = await invoke<MonitoredTask[]>('list_monitored_tasks')
        if (cancelled) return
        setTasks(next)
        setLoaded(true)
        setLoadFailed(false)
        const previous = JSON.parse(localStorage.getItem('task-widget-statuses') || '{}') as Record<string, TaskStatus>
        if (initialized.current) {
          let granted = await isPermissionGranted()
          if (!granted) granted = (await requestPermission()) === 'granted'
          if (granted) {
            for (const task of next) {
              if (previous[task.id] === task.status) continue
              if (task.status === 'completed' || task.status === 'failed' || task.status === 'waiting') {
                sendNotification({
                  title: task.status === 'completed' ? 'Codex 任务已完成' : task.status === 'failed' ? 'Codex 任务执行失败' : `Codex 任务${taskStatusLabel(task)}`,
                  body: `${task.title} · ${task.profileName}`,
                })
              }
            }
          }
        }
        localStorage.setItem('task-widget-statuses', JSON.stringify(Object.fromEntries(next.map((task) => [task.id, task.status]))))
        initialized.current = true
      } catch {
        // Keep the last known list when a profile log is temporarily unavailable.
        if (!cancelled) setLoadFailed(true)
      } finally {
        if (!cancelled) refreshTimer = window.setTimeout(refresh, 8000)
      }
    }
    refresh()
    const clockTimer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      cancelled = true
      window.clearTimeout(refreshTimer)
      window.clearInterval(clockTimer)
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('task-widget-collapsed', String(collapsed))
    getCurrentWindow().setSize(new LogicalSize(collapsed ? 56 : 336, collapsed ? 56 : showAllRecent ? 680 : 560)).catch(() => undefined)
  }, [collapsed, showAllRecent])

  const active = tasks.filter((task) => task.status === 'running' || task.status === 'waiting')
  const allRecent = tasks.filter((task) => task.status === 'completed' || task.status === 'failed')
  const recent = allRecent.slice(0, showAllRecent ? 12 : 3)
  const waitingCount = active.filter((task) => task.status === 'waiting').length
  const robotState = waitingCount ? 'waiting' : active.length ? 'running' : 'idle'
  const robotCount = waitingCount || active.length
  const robotLabel = waitingCount ? '等待输入' : active.length ? '运行中' : '当前空闲'
  void now

  if (collapsed) {
    return (
      <div
        className={`task-robot-bubble ${robotState}`}
        title={`${robotLabel}${robotCount ? ` · ${robotCount}` : ''}`}
        onMouseDown={(event) => {
          if (event.button === 0 && !(event.target as HTMLElement).closest('button')) getCurrentWindow().startDragging().catch(() => undefined)
        }}
      >
        <span className="task-robot-bubble-ring" aria-hidden="true" />
        <span className="task-robot-bubble-shell">
          <i className="task-robot-bubble-grip" />
          <i className="task-robot-bubble-antenna" />
          <button className="task-robot-bubble-face" type="button" aria-label={`${robotLabel}${robotCount ? `，${robotCount} 项` : ''}，展开任务列表`} onClick={() => setCollapsed(false)}><i /><i /></button>
          <b>{robotCount || '✓'}</b>
        </span>
      </div>
    )
  }

  const robot = (
    <div
      className={`task-robot ${robotState}`}
      onMouseDown={(event) => {
        if (event.button === 0 && !(event.target as HTMLElement).closest('button')) getCurrentWindow().startDragging().catch(() => undefined)
      }}
    >
      <span className="task-robot-orbit" aria-hidden="true" />
      <span className="task-robot-antenna" aria-hidden="true"><i /></span>
      <div className="task-robot-shell">
        <span className="task-robot-grip" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <i key={index} />)}</span>
        <span className="task-robot-side" aria-hidden="true" />
        <div className="task-robot-face" aria-hidden="true">
          <span className="task-robot-eye left" />
          <span className="task-robot-eye right" />
          {robotState === 'running' && <span className="task-robot-runner"><i /></span>}
        </div>
        {robotState === 'idle' && <span className="task-robot-check" aria-hidden="true">✓</span>}
        <div className="task-robot-status"><strong>{robotLabel}</strong>{robotCount > 0 && <b>{robotCount}</b>}</div>
        <button className="task-robot-toggle" type="button" aria-label={collapsed ? '展开任务列表' : '收起任务列表'} onClick={() => setCollapsed((value) => !value)}>{collapsed ? '⌄' : '⌃'}</button>
      </div>
    </div>
  )

  return (
    <main className={`task-widget-stage ${collapsed ? 'collapsed' : 'expanded'} ${robotState}`}>
      {robot}
      {!collapsed && <span className="task-robot-connector" aria-hidden="true" />}
      {!collapsed && (
        <div className="task-widget-panel">
          <header className="task-widget-panel-header">
            <strong>任务列表</strong>
            <button type="button" aria-label="隐藏任务挂件" title="隐藏，可从系统托盘重新显示" onClick={() => invoke('hide_task_widget')}>×</button>
          </header>
          <div className="task-widget-body">
          <section>
            {!loaded && !loadFailed && <p className="task-widget-empty" role="status">正在读取任务状态...</p>}
            {!loaded && loadFailed && <p className="task-widget-empty error" role="alert">暂时无法读取任务状态，正在自动重试。</p>}
            {loaded && active.length === 0 && recent.length === 0 && <div className="task-widget-empty-state"><span>✓</span><strong>当前没有任务</strong><small>一切已完成，继续保持！</small></div>}
            {loaded && active.length === 0 && recent.length > 0 && <p className="task-widget-empty calm"><span aria-hidden="true">✓</span> 当前没有进行中的任务</p>}
            {active.map((task) => (
              <button className={`task-widget-row ${task.status}`} type="button" key={task.id} title={task.title} onClick={() => invoke('show_task_owner', { profileId: task.profileId })}>
                <span className={`task-status-dot ${task.status}`} aria-hidden="true"><span>{taskStatusIcon(task.status)}</span></span>
                <span className="task-widget-copy"><strong>{task.title}</strong>{task.summary && <small className="task-widget-summary">{task.summary}</small>}<small>{task.profileName} · {elapsed(task.startedAt)}</small></span>
                <em>{taskStatusLabel(task)}</em>
              </button>
            ))}
          </section>
          {recent.length > 0 && <section className="task-widget-recent">
            <h2><span>最近结束</span><b>{recent.length}</b></h2>
            {recent.map((task) => (
              <button className={`task-widget-row ${task.status}`} type="button" key={task.id} title={task.title} onClick={() => invoke('show_task_owner', { profileId: task.profileId })}>
                <span className={`task-status-dot ${task.status}`} aria-hidden="true"><span>{taskStatusIcon(task.status)}</span></span>
                <span className="task-widget-copy"><strong>{task.title}</strong>{task.summary && <small className="task-widget-summary">{task.summary}</small>}<small>{task.profileName} · {new Date(task.updatedAt).toLocaleTimeString()}</small></span>
                <em>{taskStatusLabel(task)}</em>
              </button>
            ))}
          </section>}
          </div>
          <footer className="task-widget-panel-footer">
            <strong>{waitingCount ? `共 ${waitingCount} 项待处理` : active.length ? `共 ${active.length} 项进行中` : '已完成所有任务'}</strong>
            {allRecent.length > 3 && (
              <button className="task-widget-more" type="button" onClick={() => setShowAllRecent((value) => !value)}>
                {showAllRecent ? '收起' : `查看全部 ${allRecent.length}`}
              </button>
            )}
          </footer>
        </div>
      )}
    </main>
  )
}

function NoticeToast({ notice, onDismiss }: { notice: Notice; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (!notice.duration) return
    const timer = window.setTimeout(() => onDismiss(notice.id), notice.duration)
    return () => window.clearTimeout(timer)
  }, [notice.id, notice.duration])

  const icon = notice.tone === 'success' ? '✓' : notice.tone === 'error' ? '!' : 'i'

  return (
    <div className={`notice-toast ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <span className="notice-icon" aria-hidden="true">{icon}</span>
      <div className="notice-copy">
        <strong>{notice.title}</strong>
        {notice.detail && <p>{notice.detail}</p>}
      </div>
      <button className="notice-close" type="button" aria-label="关闭通知" onClick={() => onDismiss(notice.id)}>×</button>
    </div>
  )
}

function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [mode, setMode] = useState<Mode>('detail')
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>('profiles')
  const [formName, setFormName] = useState('')
  const [formAuthJsonPath, setFormAuthJsonPath] = useState('')
  const [formAuthMode, setFormAuthMode] = useState<AuthMode>('account')
  const [formApiKey, setFormApiKey] = useState('')
  const [formApiProvider, setFormApiProvider] = useState<ApiProvider>('openai')
  const [formApiBaseUrl, setFormApiBaseUrl] = useState('https://api.openai.com/v1')
  const [formApiRouteEnabled, setFormApiRouteEnabled] = useState(false)
  const [formApiRouteModel, setFormApiRouteModel] = useState('gpt-5.5')
  const [codexAppId, setCodexAppId] = useState('')
  const [proxyEnabled, setProxyEnabled] = useState(false)
  const [proxyProtocol, setProxyProtocol] = useState<ProxyProtocol>('http')
  const [proxyHost, setProxyHost] = useState('')
  const [proxyPort, setProxyPort] = useState('')
  const [launchAtStartup, setLaunchAtStartup] = useState(false)
  const [taskWidgetEnabled, setTaskWidgetEnabled] = useState(true)
  const [theme, setTheme] = useState<Theme>('light')
  const [detectedCodexAppId, setDetectedCodexAppId] = useState<string | null>(null)
  const [notices, setNotices] = useState<Notice[]>([])
  const [busy, setBusy] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateProgress, setUpdateProgress] = useState('')
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [loadingLabel, setLoadingLabel] = useState('')
  const [resources, setResources] = useState<SharedResources | null>(null)
  const [sharedPlugins, setSharedPlugins] = useState<SharedPlugins | null>(null)
  const [agentsDraft, setAgentsDraft] = useState('')
  const [instances, setInstances] = useState<CodexInstance[]>([])
  const [profileInspection, setProfileInspection] = useState<ProfileInspection | null>(null)
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  const [gitInstallKind, setGitInstallKind] = useState<ResourceKind | null>(null)
  const codexAppIdDetectionStarted = useRef(false)
  const resourceSyncStarted = useRef(false)
  const noticeId = useRef(0)

  function dismissNotice(id: number) {
    setNotices((current) => current.filter((notice) => notice.id !== id))
  }

  function showNotice(title: string, tone: NoticeTone = 'success', detail?: string) {
    const notice: Notice = {
      id: ++noticeId.current,
      tone,
      title,
      detail,
      duration: tone === 'error' ? undefined : tone === 'info' ? 4000 : 3000,
    }
    setNotices((current) => [...current.slice(-2), notice])
  }

  function showError(title: string, error: unknown) {
    showNotice(title, 'error', String(error))
  }

  async function loadState(): Promise<AppState> {
    const nextState = await invoke<AppState>('get_app_state')
    setState(nextState)
    setCodexAppId(nextState.settings.codexAppId)
    setProxyEnabled(Boolean(nextState.settings.proxyEnabled))
    setProxyProtocol(nextState.settings.proxyProtocol || 'http')
    setProxyHost(nextState.settings.proxyHost || '')
    setProxyPort(nextState.settings.proxyPort || '')
    setLaunchAtStartup(Boolean(nextState.settings.launchAtStartup))
    setTaskWidgetEnabled(nextState.settings.taskWidgetEnabled !== false)
    setTheme(nextState.settings.theme || 'light')
    setSelectedProfileId((current) => current || nextState.activeProfileId || nextState.profiles[0]?.id || '')
    return nextState
  }

  async function checkForUpdate(silent = false) {
    setUpdateBusy(true)
    setUpdateProgress('')

    try {
      const update = await check()
      if (!update) {
        setUpdateInfo({ currentVersion: appVersion, available: false })
        if (!silent) showNotice('当前已是最新版本', 'success')
        return
      }

      setUpdateInfo({
        currentVersion: update.currentVersion || appVersion,
        latestVersion: update.version,
        releaseDate: update.date,
        notes: update.body,
        available: true,
      })

      setUpdateBusy(false)
      requestConfirm({
        title: `安装更新：${update.version}`,
        body: '安装完成后应用会自动重启。',
        confirmLabel: '下载并安装',
        intent: 'warning',
        details: [
          `当前版本：${update.currentVersion || appVersion || '未知'}`,
          `新版本：${update.version}`,
          ...(update.body ? update.body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 6) : []),
          '安装完成后重启应用',
        ],
        onConfirm: async () => {
          setUpdateBusy(true)
          try {
            let downloaded = 0
            let contentLength = 0
            await update.downloadAndInstall((event) => {
              switch (event.event) {
                case 'Started':
                  contentLength = event.data.contentLength ?? 0
                  setUpdateProgress('开始下载更新...')
                  break
                case 'Progress':
                  downloaded += event.data.chunkLength
                  setUpdateProgress(contentLength ? `下载中 ${Math.round((downloaded / contentLength) * 100)}%` : '下载中...')
                  break
                case 'Finished':
                  setUpdateProgress('安装完成，正在重启...')
                  break
              }
            })
            await relaunch()
          } catch (error) {
            showError('安装更新失败', error)
          } finally {
            setUpdateBusy(false)
          }
        },
      })
    } catch (error) {
      if (!silent) showError('检查更新失败', error)
    } finally {
      setUpdateBusy(false)
    }
  }

  async function detectAndSaveCodexAppId(settings: AppSettings) {
    const detected = await invoke<string | null>('detect_codex_app_id')
    setDetectedCodexAppId(detected)
    if (!detected || settings.codexAppId === detected) return
    await invoke('save_settings', {
      settings: {
        ...settings,
        codexAppId: detected,
        envKey: 'CODEX_HOME',
        deleteOpenAiApiKeyBeforeLaunch: false,
      },
    })
    setCodexAppId(detected)
  }

  useEffect(() => {
    loadState()
      .then(() => {
        getVersion().then(setAppVersion).catch(() => setAppVersion(''))
        checkForUpdate(true)
        resourceSyncStarted.current = true
        refreshResources(false)
      })
      .catch((error) => showError('加载应用状态失败', error))
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }, [theme])

  useEffect(() => {
    if (activeMenu !== 'settings' || !state || codexAppIdDetectionStarted.current) return
    codexAppIdDetectionStarted.current = true
    detectAndSaveCodexAppId(state.settings).catch((error) => showError('检测 Codex AppID 失败', error))
  }, [activeMenu, state])

  useEffect(() => {
    if (activeMenu !== 'resources' || resources || resourceSyncStarted.current) return
    resourceSyncStarted.current = true
    refreshResources(false)
  }, [activeMenu, resources])

  useEffect(() => {
    if (activeMenu !== 'profiles') return
    invoke<CodexInstance[]>('list_codex_instances').then(setInstances).catch(() => setInstances([]))
  }, [activeMenu])

  const selectedProfile = state?.profiles.find((profile) => profile.id === selectedProfileId)

  useEffect(() => {
    if (!selectedProfileId || mode !== 'detail') {
      setProfileInspection(null)
      return
    }

    let cancelled = false
    let refreshing = false
    const refreshInspection = () => {
      if (refreshing) return
      refreshing = true
      invoke<ProfileInspection>('inspect_profile', { profileId: selectedProfileId })
        .then((inspection) => {
          if (!cancelled) setProfileInspection(inspection)
        })
        .catch(() => {
          if (!cancelled) setProfileInspection(null)
        })
        .finally(() => {
          refreshing = false
        })
    }
    refreshInspection()
    const timer = window.setInterval(refreshInspection, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [selectedProfileId, mode])


  function applyApiProviderPreset(provider: ApiProvider) {
    const preset = API_PROVIDER_PRESETS[provider]
    setFormApiProvider(provider)
    setFormApiBaseUrl(preset.baseUrl)
    setFormApiRouteEnabled(preset.routeEnabled)
    setFormApiRouteModel(preset.model)
  }

  function startNewProfile() {
    setActiveMenu('profiles')
    setMode('new')
    setFormName('')
    setFormAuthJsonPath('')
    setFormAuthMode('account')
    setFormApiKey('')
    applyApiProviderPreset('openai')
  }

  function startEditProfile(profile: Profile) {
    setActiveMenu('profiles')
    setMode('edit')
    setFormName(profile.name)
    setFormAuthJsonPath('')
    setFormAuthMode(profile.authMode || 'account')
    setFormApiKey(profile.apiKey || '')
    setFormApiProvider(profile.apiProvider || 'custom')
    setFormApiBaseUrl(profile.apiBaseUrl || API_PROVIDER_PRESETS[profile.apiProvider || 'openai'].baseUrl)
    setFormApiRouteEnabled(Boolean(profile.apiRouteEnabled))
    setFormApiRouteModel(profile.apiRouteModel || API_PROVIDER_PRESETS[profile.apiProvider || 'openai'].model)
  }

  function showProfile(profileId: string) {
    setActiveMenu('profiles')
    setSelectedProfileId(profileId)
    setMode('detail')
  }

  async function chooseAuthJsonFile() {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        filters: [{ name: 'auth.json', extensions: ['json'] }],
        title: '选择 auth.json 文件',
      })
      if (typeof selected === 'string') {
        setFormAuthJsonPath(selected)
      }
    } catch (error) {
      showError('选择 auth.json 失败', error)
    }
  }

  async function runAction(action: () => Promise<string | void>, label = '正在处理...') {
    setBusy(true)
    setLoadingLabel(label)
    try {
      const result = await action()
      if (result) {
        const tone: NoticeTone = /失败|错误|无法/.test(result) ? 'error' : 'success'
        showNotice(result, tone)
      }
      await loadState()
    } catch (error) {
      showError('操作失败', error)
    } finally {
      setBusy(false)
      setLoadingLabel('')
    }
  }

  function requestConfirm(request: ConfirmRequest) {
    setConfirmRequest(request)
  }

  async function confirmAndClose() {
    const request = confirmRequest
    if (!request) return
    setConfirmRequest(null)
    await request.onConfirm()
  }

  async function saveProfileForm() {
    await runAction(async () => {
      if (mode === 'new') {
        const profile = await invoke<Profile>('create_profile', {
          name: formName,
          sourcePath: '',
          authMode: formAuthMode,
          apiKey: formAuthMode === 'apiKey' ? formApiKey : null,
          authJsonPath: formAuthMode === 'account' ? formAuthJsonPath : null,
          apiProvider: formAuthMode === 'apiKey' ? formApiProvider : null,
          apiBaseUrl: formAuthMode === 'apiKey' ? formApiBaseUrl : null,
          apiRouteEnabled: formAuthMode === 'apiKey' ? formApiRouteEnabled : false,
          apiRouteModel: formAuthMode === 'apiKey' ? formApiRouteModel : null,
        })
        setSelectedProfileId(profile.id)
        setMode('detail')
        return `已创建 Profile：${profile.name}`
      }

      if (!selectedProfile) return
      const profile = await invoke<Profile>('update_profile', {
        profileId: selectedProfile.id,
        name: formName,
        authMode: formAuthMode,
        apiKey: formAuthMode === 'apiKey' ? formApiKey : null,
        authJsonPath: formAuthMode === 'account' ? formAuthJsonPath : null,
        apiProvider: formAuthMode === 'apiKey' ? formApiProvider : null,
        apiBaseUrl: formAuthMode === 'apiKey' ? formApiBaseUrl : null,
        apiRouteEnabled: formAuthMode === 'apiKey' ? formApiRouteEnabled : false,
        apiRouteModel: formAuthMode === 'apiKey' ? formApiRouteModel : null,
      })
      setSelectedProfileId(profile.id)
      setMode('detail')
      return `已保存 Profile：${profile.name}`
    }, mode === 'new' ? '正在创建 Profile...' : '正在保存 Profile...')
  }


  async function testProfile(profileId: string) {
    await runAction(async () => {
      const result = await invoke<ConnectionTestResult>('test_profile_connection', { profileId })
      return result.ok ? `连通测试通过：${result.endpoint}` : `连通测试失败：HTTP ${result.status}，${result.endpoint}`
    }, '正在测试连接...')
  }

  async function testLoginForm() {
    await runAction(async () => {
      const result = await invoke<ConnectionTestResult>('test_login_connection', {
        authMode: formAuthMode,
        apiKey: formAuthMode === 'apiKey' ? formApiKey : null,
        authJsonPath: formAuthMode === 'account' ? formAuthJsonPath : null,
        sourcePath: '',
        apiBaseUrl: formAuthMode === 'apiKey' ? formApiBaseUrl : null,
      })
      return result.ok ? `连通测试通过：${result.endpoint}` : `连通测试失败：HTTP ${result.status}，${result.endpoint}`
    }, '正在测试连接...')
  }

  async function launchProfile(profileId: string) {
    const profile = state?.profiles.find((item) => item.id === profileId)
    requestConfirm({
      title: `启动 Profile：${profile?.name || '未知'}`,
      body: '此操作会用当前 Profile 的独立环境启动 Codex。',
      confirmLabel: '确认启动',
      intent: 'warning',
      details: ['使用独立 CODEX_HOME', '使用独立应用数据目录', proxyEnabled ? '为此实例应用代理' : '此实例不使用代理'],
      onConfirm: async () => {
        await runAction(async () => {
          await invoke<CodexInstance>('launch_codex', { profileId })
          setInstances(await invoke<CodexInstance[]>('list_codex_instances'))
          return '已启动独立 Codex 实例。'
        }, `正在启动 ${profile?.name || 'Profile'}...`)
      },
    })
  }

  async function launchDefaultCodex() {
    requestConfirm({
      title: '默认启动 Codex',
      body: '此操作不会修改 CODEX_HOME 或 OPENAI_API_KEY，但会同步当前代理设置。',
      confirmLabel: '确认启动',
      intent: 'warning',
      details: ['清理本工具旧版写入的代理环境变量', '启动 Codex'],
      onConfirm: async () => {
        await runAction(async () => {
          await invoke('launch_default_codex')
          return '已按当前系统环境默认启动 Codex；本程序代理不会应用到 Codex。'
        }, '正在启动 Codex...')
      },
    })
  }

  async function restoreDefaultHome() {
    requestConfirm({
      title: '恢复默认 Home',
      body: '此操作会删除用户级 CODEX_HOME。之后手动启动 Codex 会回到默认 Home。',
      confirmLabel: '恢复默认 Home',
      intent: 'danger',
      details: ['删除用户级 CODEX_HOME', '不会删除任何 Profile 文件', '通常会回到 C:\\Users\\frank\\.codex'],
      onConfirm: async () => {
        await runAction(async () => {
          await invoke('clear_codex_home')
          setSelectedProfileId('')
          return '已清除用户级 CODEX_HOME。手动启动 Codex 将使用默认 Home。'
        }, '正在恢复默认 Home...')
      },
    })
  }

  async function saveSettings() {
    requestConfirm({
      title: '保存设置',
      body: '这些设置会影响本程序网络请求和后续 Codex 启动方式。',
      confirmLabel: '保存设置',
      intent: 'warning',
      details: [
        ...(proxyEnabled
          ? [`本程序立即使用代理：${proxyProtocol}://${proxyHost}:${proxyPort}`, '后续 Codex 实例使用此代理']
          : ['本程序立即停止使用代理', '后续 Codex 实例不注入代理']),
        launchAtStartup ? '启用登录 Windows 后自动启动' : '关闭登录 Windows 后自动启动',
        taskWidgetEnabled ? '启用任务挂件' : '关闭任务挂件',
        `界面主题：${theme === 'dark' ? 'Dark' : 'Light'}`,
      ],
      onConfirm: async () => {
        await runAction(async () => {
          await invoke('save_settings', {
            settings: {
              codexAppId,
              envKey: 'CODEX_HOME',
              deleteOpenAiApiKeyBeforeLaunch: false,
              proxyEnabled,
              proxyProtocol,
              proxyHost,
              proxyPort,
              launchAtStartup,
              taskWidgetEnabled,
              theme,
            },
          })
          return '设置已保存。'
        }, '正在保存设置...')
      },
    })
  }

  async function revealProfile(profileId: string) {
    await runAction(async () => {
      await invoke('reveal_profile_folder', { profileId })
    }, '正在打开目录...')
  }

  async function refreshResources(notify = true) {
    setBusy(true)
    setLoadingLabel('正在刷新共享资源...')
    try {
      const syncResult = await invoke<AutomaticResourceSyncResult>('auto_sync_resources')
      const [next, plugins] = await Promise.all([
        invoke<SharedResources>('get_shared_resources'),
        invoke<SharedPlugins>('get_shared_plugins'),
      ])
      setResources(next)
      setSharedPlugins(plugins)
      setAgentsDraft(next.agentsContent)
      const syncIssues = [...syncResult.plugins.conflicts, ...syncResult.plugins.profileErrors]
      if (syncIssues.length) {
        showNotice('共享资源已刷新，但自动同步有异常', 'error', syncIssues.join('\n'))
      } else if (notify) {
        showNotice(
          '共享资源已刷新并同步',
          'success',
          `导入 Skill ${syncResult.skills.imported} 个，同步插件 ${syncResult.plugins.updated} 个。`,
        )
      }
    } catch (error) {
      showError('刷新共享资源失败', error)
    } finally {
      setBusy(false)
      setLoadingLabel('')
    }
  }

  function operationSummary(result: ResourceOperationResult) {
    const summary = [
      result.succeeded.length ? `成功 ${result.succeeded.length}` : '',
      result.skipped.length ? `跳过 ${result.skipped.length}` : '',
      result.failed.length ? `失败 ${result.failed.length}` : '',
      result.profileErrors.length ? `Profile 同步失败 ${result.profileErrors.length}` : '',
    ].filter(Boolean).join('，')
    const details = [...result.failed, ...result.profileErrors]
    if (details.length) showNotice(`资源操作完成：${summary}`, 'error', details.join('\n'))
    return details.length ? undefined : `资源操作完成：${summary || '无变更'}。`
  }

  async function refreshResourceLists() {
    const [nextResources, nextPlugins] = await Promise.all([
      invoke<SharedResources>('get_shared_resources'),
      invoke<SharedPlugins>('get_shared_plugins'),
    ])
    setResources(nextResources)
    setSharedPlugins(nextPlugins)
    setAgentsDraft(nextResources.agentsContent)
  }

  async function installLocalResource(kind: ResourceKind) {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: kind === 'skill' ? '选择包含 SKILL.md 的目录' : '选择包含 .codex-plugin/plugin.json 的目录',
      })
      if (typeof selected !== 'string') return
      requestConfirm({
        title: `从本地添加${kind === 'skill' ? ' Skill' : '插件'}`,
        body: '将校验并复制该目录；若存在同名资源，将以新内容替换。',
        confirmLabel: '添加资源',
        intent: 'warning',
        details: [selected],
        onConfirm: async () => {
          await runAction(async () => {
            const result = await invoke<ResourceOperationResult>('install_resource', {
              kind,
              sourceType: 'local',
              source: selected,
              subpath: null,
            })
            await refreshResourceLists()
            return operationSummary(result)
          }, '正在安装本地资源...')
        },
      })
    } catch (error) {
      showError('选择资源目录失败', error)
    }
  }

  async function installGitResource(kind: ResourceKind, source: string, subpath: string) {
    setGitInstallKind(null)
    await runAction(async () => {
      const result = await invoke<ResourceOperationResult>('install_resource', {
        kind,
        sourceType: 'git',
        source,
        subpath: subpath.trim() || null,
      })
      await refreshResourceLists()
      return operationSummary(result)
    }, '正在从 Git 下载并安装...')
  }

  async function checkResourceUpdate(kind: ResourceKind, name: string) {
    setBusy(true)
    setLoadingLabel(`正在检查 ${name}...`)
    try {
      const result = await invoke<ResourceUpdateCheck>('check_resource_update', { kind, name })
      if (!result.updateAvailable) {
        showNotice(`${name} 已是最新`, 'success')
        return
      }
      const versionDetail = result.latestVersion
        ? `当前 ${result.currentVersion || '未知'}，可更新到 ${result.latestVersion}。`
        : '来源内容已有变化。'
      requestConfirm({
        title: `发现更新：${name}`,
        body: versionDetail,
        confirmLabel: '立即更新',
        intent: 'warning',
        onConfirm: async () => {
          await runAction(async () => {
            const updated = await invoke<ResourceOperationResult>('update_resource', { kind, name })
            await refreshResourceLists()
            return operationSummary(updated)
          }, `正在更新 ${name}...`)
        },
      })
    } catch (error) {
      showError(`检查 ${name} 更新失败`, error)
    } finally {
      setBusy(false)
      setLoadingLabel('')
    }
  }

  function deleteResource(kind: ResourceKind, name: string) {
    requestConfirm({
      title: `删除${kind === 'skill' ? ' Skill' : '插件'}：${name}`,
      body: kind === 'plugin'
        ? '将删除共享插件、全部托管 Profile 中的同步缓存和对应启用配置。'
        : '将删除 ~/.agents/skills 中的共享 Skill。',
      confirmLabel: '删除资源',
      intent: 'danger',
      requireText: name,
      requireTextLabel: `输入 ${name} 确认`,
      onConfirm: async () => {
        await runAction(async () => {
          const result = await invoke<ResourceOperationResult>('delete_resource', { kind, name })
          await refreshResourceLists()
          return operationSummary(result)
        }, `正在删除 ${name}...`)
      },
    })
  }

  async function saveAgents() {
    await runAction(async () => {
      await invoke('save_shared_agents', { content: agentsDraft })
      const next = await invoke<SharedResources>('get_shared_resources')
      setResources(next)
      return 'AGENTS.md 已保存。'
    }, '正在保存共享资源...')
  }

  async function stopInstance(pid: number) {
    await runAction(async () => {
      await invoke('stop_codex_instance', { pid })
      setInstances(await invoke<CodexInstance[]>('list_codex_instances'))
      return `已停止实例 PID ${pid}。`
    }, '正在停止 Codex 实例...')
  }

  async function deleteProfile(profile: Profile) {
    requestConfirm({
      title: `删除 Profile：${profile.name}`,
      body: '删除操作不可撤销。请输入 Profile 名称后才能继续。',
      confirmLabel: '删除 Profile',
      intent: 'danger',
      requireText: profile.name,
      requireTextLabel: `输入 ${profile.name}`,
      details: ['删除 Profile 记录', '删除本工具托管的 Home 目录'],
      onConfirm: async () => {
        await runAction(async () => {
          await invoke('delete_profile', { profileId: profile.id })
          setMode('detail')
          setSelectedProfileId('')
          return `已删除 Profile：${profile.name}`
        }, '正在删除 Profile...')
      },
    })
  }

  if (!state) {
    return <main className="app-loading"><LoadingIndicator label="正在加载应用配置..." /></main>
  }

  const formIsValid =
    formName.trim() &&
    (formAuthMode === 'account' || formApiKey.trim()) &&
    (!formApiRouteEnabled || (formApiBaseUrl.trim() && formApiRouteModel.trim()))
  const accountProfiles = state.profiles.filter((profile) => profile.authMode === 'account').length
  const apiKeyProfiles = state.profiles.filter((profile) => profile.authMode === 'apiKey').length
  const activeProfile = state.profiles.find((profile) => profile.id === state.activeProfileId)
  const ownerInfo = [
    { label: '作者', value: 'Frank' },
    { label: '项目', value: 'Codex Switch Helper' },
    { label: '仓库', value: 'https://github.com/frank9306/codex-switch-helper', href: 'https://github.com/frank9306/codex-switch-helper' },
    { label: '定位', value: '本地 Codex Profile 管理工具' },
    { label: '版本', value: appVersion || '未知' },
  ]
  const stats = [
    { label: 'Profiles', value: state.profiles.length, icon: '#', tone: 'blue' },
    { label: '账号登录', value: accountProfiles, icon: '◆', tone: 'purple' },
    { label: 'API Key', value: apiKeyProfiles, icon: '⌁', tone: 'mint' },
  ]

  return (
    <main className="shell">
      <aside className="side-rail" aria-label="主导航">
        <button
          className={`rail-item ${activeMenu === 'profiles' ? 'active' : ''}`}
          type="button"
          aria-label="Profiles"
          onClick={() => setActiveMenu('profiles')}
        >
          P
        </button>
        <button
          className={`rail-item ${activeMenu === 'resources' ? 'active' : ''}`}
          type="button"
          aria-label="Resources"
          onClick={() => setActiveMenu('resources')}
        >
          A
        </button>
        <button
          className={`rail-item ${activeMenu === 'settings' ? 'active' : ''}`}
          type="button"
          aria-label="Settings"
          onClick={() => setActiveMenu('settings')}
        >
          ⚙
        </button>
        <button
          className={`rail-item ${activeMenu === 'about' ? 'active' : ''}`}
          type="button"
          aria-label="About"
          onClick={() => setActiveMenu('about')}
        >
          ℹ
        </button>
      </aside>

      <section className="dashboard">
        <section className="topbar">
          <div className="brand-lockup">
            <span className="brand-mark">C</span>
            <div>
              <p className="eyebrow">Codex Switch Helper</p>
              <h1>{activeMenu === 'about' ? '关于' : activeMenu === 'settings' ? '设置' : activeMenu === 'resources' ? '共享资源' : 'Profiles'}</h1>
            </div>
          </div>
          {activeMenu === 'profiles' && (
            <div className="header-actions">
              <button className="secondary-action" disabled={busy} onClick={restoreDefaultHome} type="button">
                恢复默认 Home
              </button>
              <button className="primary-action" disabled={busy} onClick={launchDefaultCodex} type="button">
                默认启动 Codex
              </button>
            </div>
          )}
        </section>

        {activeMenu === 'profiles' ? (
          <>
            <section className="stats-grid">
              {stats.map((item) => (
                <article className="stat-card" key={item.label}>
                  <span className={`stat-icon ${item.tone}`}>{item.icon}</span>
                  <div>
                    <p>{item.label}</p>
                    <strong>{item.value}</strong>
                  </div>
                </article>
              ))}
            </section>

            <section className="overview-card">
              <div className="section-title">
                <h2>当前环境</h2>
                <p>默认启动不修改环境；恢复默认 Home 只删除 CODEX_HOME，不处理 OPENAI_API_KEY。</p>
              </div>
              <div className="env-card">
                <span>System CODEX_HOME</span>
                <code>{state.currentCodexHome || '未设置'}</code>
              </div>
              <div className="active-profile">
                <span>当前激活 Profile</span>
                <strong>{activeProfile?.name || '未激活'}</strong>
              </div>
            </section>

            <section className="content-grid">
              <aside className="panel profile-list">
                <div className="panel-header">
                  <div className="section-title">
                    <h2>Profiles</h2>
                    <p>{state.profiles.length} 个账号配置</p>
                  </div>
                  <button className="primary-action compact" disabled={busy} onClick={startNewProfile} type="button">
                    新建
                  </button>
                </div>

                {state.profiles.length === 0 && <p className="empty list-empty">还没有 Profile，点击上方新建。</p>}

                <div className="profile-card-grid">
                  {state.profiles.map((profile) => {
                    const isActive = profile.id === state.activeProfileId
                    return (
                      <button
                        className={`profile-card ${profile.id === selectedProfileId && mode === 'detail' ? 'active' : ''}`}
                        key={profile.id}
                        onClick={() => showProfile(profile.id)}
                        type="button"
                      >
                        <span className="profile-card-topline">
                          <span className="profile-avatar">{(profile.name || 'C').slice(0, 1).toUpperCase()}</span>
                          <span className="profile-badges">
                            <em>{profile.authMode === 'apiKey' ? 'API Key' : '账号'}</em>
                            {isActive && <em className="hot">当前</em>}
                          </span>
                        </span>
                        <span className="profile-copy">
                          <strong>{profile.name}</strong>
                          <small>{profile.homePath}</small>
                        </span>
                        <span className="profile-card-footer">
                          <span>{profile.authMode === 'apiKey' ? 'API Key' : '账号登录'}</span>
                          <span>{profile.lastUsedAt ? '已使用' : '未启动'}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </aside>

              <section className="panel workspace-panel">
                {mode === 'new' || mode === 'edit' ? (
                  <ProfileForm
                    apiKey={formApiKey}
                    authJsonPath={formAuthJsonPath}
                    authMode={formAuthMode}
                    apiBaseUrl={formApiBaseUrl}
                    apiProvider={formApiProvider}
                    apiRouteEnabled={formApiRouteEnabled}
                    apiRouteModel={formApiRouteModel}
                    busy={busy}
                    mode={mode}
                    name={formName}
                    onApiKeyChange={setFormApiKey}
                    onAuthModeChange={setFormAuthMode}
                    onApiBaseUrlChange={setFormApiBaseUrl}
                    onApiProviderChange={applyApiProviderPreset}
                    onApiRouteEnabledChange={setFormApiRouteEnabled}
                    onApiRouteModelChange={setFormApiRouteModel}
                    onAuthJsonPathChange={setFormAuthJsonPath}
                    onCancel={() => setMode('detail')}
                    onChooseAuthJsonFile={chooseAuthJsonFile}
                    onNameChange={setFormName}
                    onSave={saveProfileForm}
                    onTest={testLoginForm}
                    valid={Boolean(formIsValid)}
                  />
                ) : selectedProfile ? (
                  <ProfileDetail
                    busy={busy}
                    inspection={profileInspection}
                    instances={instances.filter((instance) => instance.profileId === selectedProfile.id)}
                    profile={selectedProfile}
                    onDelete={() => deleteProfile(selectedProfile)}
                    onEdit={() => startEditProfile(selectedProfile)}
                    onLaunch={() => launchProfile(selectedProfile.id)}
                    onTest={() => testProfile(selectedProfile.id)}
                    onReveal={() => revealProfile(selectedProfile.id)}
                    onStop={stopInstance}
                  />
                ) : (
                  <div className="empty-state">
                    <h2>选择或新建一个 Profile</h2>
                    <p>每个 Profile 使用独立托管目录。</p>
                    <button className="primary-action" onClick={startNewProfile} type="button">
                      新建 Profile
                    </button>
                  </div>
                )}
              </section>
            </section>
          </>
        ) : activeMenu === 'resources' ? (
          <ResourcesPanel
            busy={busy}
            draft={agentsDraft}
            plugins={sharedPlugins}
            resources={resources}
            onChange={setAgentsDraft}
            onRefresh={() => refreshResources(true)}
            onSave={saveAgents}
            onAddLocal={installLocalResource}
            onAddGit={setGitInstallKind}
            onCheckUpdate={checkResourceUpdate}
            onDelete={deleteResource}
          />
        ) : activeMenu === 'settings' ? (
          <section className="settings-grid">
            <section className="panel settings-form-panel">
              <div className="section-title">
                <h2>代理</h2>
                <p>代理会应用到本程序和之后启动的 Codex 实例。</p>
              </div>

              <label className="toggle-row settings-toggle">
                <input type="checkbox" checked={proxyEnabled} onChange={(event) => setProxyEnabled(event.target.checked)} />
                <span>启用代理</span>
              </label>

              <div className="field-block">
                <span>协议</span>
                <div className="segmented">
                  <button className={proxyProtocol === 'http' ? 'active' : ''} onClick={() => setProxyProtocol('http')} type="button">
                    HTTP
                  </button>
                  <button className={proxyProtocol === 'socks5' ? 'active' : ''} onClick={() => setProxyProtocol('socks5')} type="button">
                    SOCKS5
                  </button>
                </div>
              </div>

              <label>
                <span>主机</span>
                <input placeholder="127.0.0.1" value={proxyHost} onChange={(event) => setProxyHost(event.target.value)} />
              </label>

              <label>
                <span>端口</span>
                <input inputMode="numeric" placeholder="7890" value={proxyPort} onChange={(event) => setProxyPort(event.target.value)} />
              </label>

              <code>{proxyEnabled && proxyHost && proxyPort ? proxyProtocol + '://' + proxyHost + ':' + proxyPort : '未启用代理'}</code>
            </section>

            <section className="panel settings-form-panel">
              <div className="section-title">
                <h2>高级启动设置</h2>
                <p>AppID 会自动扫描。扫描不到或启动失败时，再手动修改。</p>
              </div>
              <label className="toggle-row settings-toggle">
                <input type="checkbox" checked={launchAtStartup} onChange={(event) => setLaunchAtStartup(event.target.checked)} />
                <span>登录 Windows 后自动启动</span>
              </label>
              <label className="toggle-row settings-toggle">
                <input type="checkbox" checked={taskWidgetEnabled} onChange={(event) => setTaskWidgetEnabled(event.target.checked)} />
                <span>启用任务挂件</span>
              </label>
              <div className="field-block">
                <span>界面主题</span>
                <div className="segmented theme-segmented">
                  <button className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')} type="button">Light</button>
                  <button className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')} type="button">Dark</button>
                </div>
              </div>
              <label>
                <span>Codex AppID</span>
                <input value={codexAppId} onChange={(event) => setCodexAppId(event.target.value)} />
              </label>
              <p className="hint">自动扫描结果：{detectedCodexAppId || '未检测到'}</p>
              <p className="hint">OPENAI_API_KEY 由每个 Profile 的登录方式自动处理，账号登录会清除，API Key 登录会写入。</p>
              <button className="secondary-action full-width" disabled={busy || !codexAppId.trim() || (proxyEnabled && (!proxyHost.trim() || !proxyPort.trim()))} onClick={saveSettings} type="button">
                保存设置
              </button>
            </section>
          </section>
        ) : (
          <section className="about-grid">
            <section className="panel about-hero">
              <div className="about-mark">C</div>
              <div className="section-title">
                <h2>关于 Codex Switch Helper</h2>
                <p>用于在 Windows 上管理多个 Codex Profile，按 Profile 切换账号登录、API Key 和 Codex Home。</p>
              </div>
              <dl className="about-facts">
                {ownerInfo.map((item) => (
                  <div key={item.label}>
                    <dt>{item.label}</dt>
                    <dd>
                      {'href' in item ? (
                        <a href={item.href} rel="noreferrer" target="_blank">
                          {item.value}
                        </a>
                      ) : (
                        item.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="panel about-panel">
              <div className="update-card no-divider">
                <div className="section-title">
                  <h2>应用更新</h2>
                  <p>启动时会自动检查一次，也可以在这里手动检查。</p>
                </div>
                {updateProgress && <p className="hint">{updateProgress}</p>}
                {updateInfo && (
                  <div className={`update-summary ${updateInfo.available ? 'available' : ''}`}>
                    <div>
                      <span>当前版本</span>
                      <strong>{updateInfo.currentVersion || appVersion || '未知'}</strong>
                    </div>
                    <div>
                      <span>{updateInfo.available ? '可用版本' : '更新状态'}</span>
                      <strong>{updateInfo.available ? updateInfo.latestVersion : '已是最新'}</strong>
                    </div>
                    {updateInfo.releaseDate && <time>{new Date(updateInfo.releaseDate).toLocaleString()}</time>}
                    {updateInfo.notes && <div className="release-notes"><span>版本内容</span><p>{updateInfo.notes}</p></div>}
                  </div>
                )}
                <button className="secondary-action full-width" disabled={updateBusy} onClick={() => checkForUpdate(false)} type="button">
                  {updateBusy ? '检查中...' : '检查更新'}
                </button>
              </div>

            </section>
          </section>
        )}
      </section>
      {confirmRequest && (
        <ConfirmDialog
          busy={busy}
          request={confirmRequest}
          onCancel={() => setConfirmRequest(null)}
          onConfirm={confirmAndClose}
        />
      )}
      {gitInstallKind && (
        <ResourceInstallDialog
          busy={busy}
          kind={gitInstallKind}
          onCancel={() => setGitInstallKind(null)}
          onInstall={installGitResource}
        />
      )}
      {(notices.length > 0 || busy || updateBusy) && (
        <div className="toast-region" aria-live="polite" aria-relevant="additions">
          {(busy || updateBusy) && (
            <div className="loading-toast" role="status">
              <LoadingIndicator label={loadingLabel || updateProgress || '正在检查更新...'} />
            </div>
          )}
          {notices.map((notice) => (
            <NoticeToast key={notice.id} notice={notice} onDismiss={dismissNotice} />
          ))}
        </div>
      )}
    </main>
  )
}

function ResourcesPanel(props: {
  busy: boolean
  draft: string
  plugins: SharedPlugins | null
  resources: SharedResources | null
  onChange: (value: string) => void
  onRefresh: () => void
  onSave: () => void
  onAddLocal: (kind: ResourceKind) => void
  onAddGit: (kind: ResourceKind) => void
  onCheckUpdate: (kind: ResourceKind, name: string) => void
  onDelete: (kind: ResourceKind, name: string) => void
}) {
  const [activeResourceView, setActiveResourceView] = useState<'prompt' | 'skills' | 'plugins'>('prompt')
  const [skillQuery, setSkillQuery] = useState('')
  const [resourceSort, setResourceSort] = useState<'name' | 'usage' | 'recent'>('usage')
  if (!props.resources) {
    return <section className="panel resource-loading"><LoadingIndicator label="正在读取共享资源..." /></section>
  }
  const normalizedQuery = skillQuery.trim().toLocaleLowerCase()
  const sortResources = <T extends { name: string; usageCount: number; lastUsedAt?: string | null }>(items: T[]) => [...items].sort((a, b) => {
    if (resourceSort === 'usage') return b.usageCount - a.usageCount || a.name.localeCompare(b.name)
    if (resourceSort === 'recent') return (b.lastUsedAt || '').localeCompare(a.lastUsedAt || '') || a.name.localeCompare(b.name)
    return a.name.localeCompare(b.name)
  })
  const filteredSkills = sortResources(props.resources.skills.filter((skill) => (
    !normalizedQuery
    || skill.name.toLocaleLowerCase().includes(normalizedQuery)
    || skill.description?.toLocaleLowerCase().includes(normalizedQuery)
    || skill.path.toLocaleLowerCase().includes(normalizedQuery)
  )))
  const sortedPlugins = sortResources(props.plugins?.plugins || [])
  const skillGroups = [
    { key: 'shared', title: '全局共享', description: '~/.agents/skills，可供所有 Profile 使用', skills: filteredSkills.filter((skill) => skill.shared) },
    { key: 'legacy', title: '默认 Home', description: '~/.codex/skills，可导入全局共享目录', skills: filteredSkills.filter((skill) => !skill.shared) },
  ].filter((group) => group.skills.length > 0)

  return (
    <section className="panel resource-workspace">
      <div className="resource-workspace-toolbar">
        <div className="segmented resource-tabs" role="tablist" aria-label="共享资源类型">
          <button className={activeResourceView === 'prompt' ? 'active' : ''} onClick={() => setActiveResourceView('prompt')} role="tab" aria-selected={activeResourceView === 'prompt'} type="button">
            AGENTS.md
          </button>
          <button className={activeResourceView === 'skills' ? 'active' : ''} onClick={() => setActiveResourceView('skills')} role="tab" aria-selected={activeResourceView === 'skills'} type="button">
            Skills <span className="tab-count">{props.resources.skills.length}</span>
          </button>
          <button className={activeResourceView === 'plugins' ? 'active' : ''} onClick={() => setActiveResourceView('plugins')} role="tab" aria-selected={activeResourceView === 'plugins'} type="button">
            插件 <span className="tab-count">{props.plugins?.plugins.length || 0}</span>
          </button>
        </div>
        <button className="secondary-action compact" disabled={props.busy} onClick={props.onRefresh} type="button">
          刷新磁盘内容
        </button>
      </div>

      {activeResourceView === 'prompt' ? (
        <div className="resource-view" role="tabpanel">
          <div className="panel-header resource-view-heading">
            <div className="section-title">
              <div className="resource-title-line"><span className="resource-icon">A</span><h2>AGENTS.md</h2></div>
              <p>所有托管 Profile 共用的全局提示词。</p>
              <code>{props.resources.agentsPath || '~/.agents/AGENTS.md'}</code>
              <small className="resource-updated-time">最后修改：{formatResourceTime(props.resources.agentsUpdatedAt)}</small>
            </div>
            <button className="primary-action compact" disabled={props.busy} onClick={props.onSave} type="button">
              保存提示词
            </button>
          </div>
          <textarea
            aria-label="AGENTS.md 内容"
            className="agents-editor"
            onChange={(event) => props.onChange(event.target.value)}
            spellCheck={false}
            value={props.draft}
          />
        </div>
      ) : activeResourceView === 'skills' ? (
        <div className="resource-view skills-view" role="tabpanel">
          <div className="skills-view-heading">
            <div className="section-title">
              <div className="resource-title-line"><span className="resource-icon skills">S</span><h2>Skills</h2></div>
              <p>按安装来源分组，搜索名称、说明或路径。</p>
            </div>
            <div className="skills-view-actions">
              <input aria-label="搜索 Skills" onChange={(event) => setSkillQuery(event.target.value)} placeholder="搜索 Skills" type="search" value={skillQuery} />
              <select aria-label="Skills 排序" onChange={(event) => setResourceSort(event.target.value as 'name' | 'usage' | 'recent')} value={resourceSort}>
                <option value="usage">按使用次数</option>
                <option value="recent">按最近使用</option>
                <option value="name">按名称</option>
              </select>
              <button className="secondary-action compact" disabled={props.busy} onClick={() => props.onAddLocal('skill')} type="button">
                从本地添加
              </button>
              <button className="secondary-action compact" disabled={props.busy} onClick={() => props.onAddGit('skill')} type="button">
                从 Git 添加
              </button>
            </div>
          </div>
          <div className="skill-source-paths">
            {props.resources.skillsPaths.map((path) => <code key={path}>{path}</code>)}
          </div>
          <div className="skill-groups">
            {skillGroups.length ? skillGroups.map((group) => (
              <section className="skill-group" key={group.key}>
                <header className="skill-group-heading">
                  <div>
                    <h3>{group.title}</h3>
                    <p>{group.description}</p>
                  </div>
                  <span>{group.skills.length}</span>
                </header>
                <div className="skill-list">
                  {group.skills.map((skill) => (
                    <article className="skill-list-row" key={skill.path}>
                      <div className="skill-identity">
                        <strong>{skill.name}</strong>
                        <span className={`skill-source ${skill.shared ? 'shared' : 'legacy'}`}>{skill.source}</span>
                        <span className="resource-version">{skill.version ? `v${skill.version}` : '版本未声明'}</span>
                      </div>
                      <div className="skill-detail">
                        <p>{skill.description || '未提供说明'}</p>
                        <code>{skill.path}</code>
                        <small className="resource-updated-time">最后更新：{formatResourceTime(skill.updatedAt)}</small>
                        <small className="resource-usage">使用 {skill.usageCount} 次 · 最近使用：{skill.lastUsedAt ? formatResourceTime(skill.lastUsedAt) : '未发现记录'}</small>
                        {skill.sourceLabel && <small className="resource-origin">来源：{skill.sourceLabel}</small>}
                      </div>
                      {skill.shared && (
                        <div className="resource-row-actions">
                          <button className="secondary-action compact" disabled={props.busy || !skill.canUpdate} title={skill.canUpdate ? '检查来源是否有新版本' : '未记录安装来源，无法检查更新'} onClick={() => props.onCheckUpdate('skill', skill.name)} type="button">检查更新</button>
                          <button className="danger compact" disabled={props.busy} onClick={() => props.onDelete('skill', skill.name)} type="button">删除</button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            )) : <div className="empty-state skill-empty"><h2>没有匹配的 Skills</h2><p>尝试缩短关键词或刷新磁盘内容。</p></div>}
          </div>
        </div>
      ) : (
        <div className="resource-view skills-view" role="tabpanel">
          <div className="skills-view-heading">
            <div className="section-title">
              <div className="resource-title-line"><span className="resource-icon plugins">P</span><h2>共享插件</h2></div>
              <p>第三方插件统一保存在 ~/.agents，并默认同步到所有托管 Profile。</p>
            </div>
            <div className="skills-view-actions">
              <select aria-label="插件排序" onChange={(event) => setResourceSort(event.target.value as 'name' | 'usage' | 'recent')} value={resourceSort}>
                <option value="usage">按使用次数</option>
                <option value="recent">按最近使用</option>
                <option value="name">按名称</option>
              </select>
              <button className="secondary-action compact" disabled={props.busy} onClick={() => props.onAddLocal('plugin')} type="button">
                从本地添加
              </button>
              <button className="secondary-action compact" disabled={props.busy} onClick={() => props.onAddGit('plugin')} type="button">
                从 Git 添加
              </button>
            </div>
          </div>
          <div className="skill-source-paths">
            <code>{props.plugins?.marketplacePath || '~/.agents/plugins/marketplace.json'}</code>
          </div>
          <div className="skill-groups">
            {sortedPlugins.length ? (
              <section className="skill-group">
                <header className="skill-group-heading">
                  <div>
                    <h3>全局共享</h3>
                    <p>官方内置插件不在此处管理</p>
                  </div>
                  <span>{sortedPlugins.length}</span>
                </header>
                <div className="skill-list">
                  {sortedPlugins.map((plugin) => {
                    const fullySynced = plugin.syncedProfiles === plugin.totalProfiles
                    return (
                      <article className="skill-list-row" key={`${plugin.name}@${plugin.version}`}>
                        <div className="skill-identity">
                          <strong>{plugin.name}</strong>
                          <span className={`skill-source ${fullySynced ? 'shared' : 'legacy'}`}>v{plugin.version}</span>
                        </div>
                        <div className="skill-detail">
                          <p>已同步 {plugin.syncedProfiles}/{plugin.totalProfiles} 个 Profile</p>
                          <code>{plugin.path}</code>
                          <small className="resource-updated-time">最后更新：{formatResourceTime(plugin.updatedAt)}</small>
                          <small className="resource-usage">使用 {plugin.usageCount} 次 · 最近使用：{plugin.lastUsedAt ? formatResourceTime(plugin.lastUsedAt) : '未发现记录'}</small>
                          {plugin.sourceLabel && <small className="resource-origin">来源：{plugin.sourceLabel}</small>}
                        </div>
                        <div className="resource-row-actions">
                          <button className="secondary-action compact" disabled={props.busy || !plugin.canUpdate} title={plugin.canUpdate ? '检查来源是否有新版本' : '未记录安装来源，无法检查更新'} onClick={() => props.onCheckUpdate('plugin', plugin.name)} type="button">检查更新</button>
                          <button className="danger compact" disabled={props.busy} onClick={() => props.onDelete('plugin', plugin.name)} type="button">删除</button>
                        </div>
                      </article>
                    )
                  })}
                </div>
              </section>
            ) : (
              <div className="empty-state skill-empty">
                <h2>还没有共享插件</h2>
                <p>点击“汇总现有插件”，从所有 Profile 收集第三方插件。</p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function LoadingIndicator(props: { label: string }) {
  return <span className="loading-indicator"><span className="spinner" aria-hidden="true" />{props.label}</span>
}

function ResourceInstallDialog(props: {
  busy: boolean
  kind: ResourceKind
  onCancel: () => void
  onInstall: (kind: ResourceKind, source: string, subpath: string) => void
}) {
  const [source, setSource] = useState('')
  const [subpath, setSubpath] = useState('')
  const valid = /^https?:\/\/\S+$/i.test(source.trim())

  return (
    <div className="confirm-backdrop" role="presentation">
      <section aria-modal="true" className="confirm-dialog resource-install-dialog" role="dialog">
        <div className="confirm-heading">
          <span className="confirm-icon">G</span>
          <div className="section-title">
            <h2>从 Git 添加{props.kind === 'skill' ? ' Skill' : '插件'}</h2>
            <p>使用仓库默认分支；可填写资源所在的仓库相对目录。</p>
          </div>
        </div>
        <label>
          Git 仓库 URL
          <input autoFocus onChange={(event) => setSource(event.target.value)} placeholder="https://github.com/owner/repository.git" type="url" value={source} />
        </label>
        <label>
          仓库子目录（可选）
          <input onChange={(event) => setSubpath(event.target.value)} placeholder={props.kind === 'skill' ? 'skills/example' : 'plugins/example'} value={subpath} />
        </label>
        <p className="hint">不支持私有仓库认证。若存在同名资源，校验成功后会替换。</p>
        <div className="confirm-actions">
          <button className="secondary-action" disabled={props.busy} onClick={props.onCancel} type="button">取消</button>
          <button className="primary-action" disabled={props.busy || !valid} onClick={() => props.onInstall(props.kind, source.trim(), subpath.trim())} type="button">下载并安装</button>
        </div>
      </section>
    </div>
  )
}

function ConfirmDialog(props: {
  busy: boolean
  request: ConfirmRequest
  onCancel: () => void
  onConfirm: () => void
}) {
  const [typedText, setTypedText] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const busyRef = useRef(props.busy)
  const onCancelRef = useRef(props.onCancel)
  const requireText = props.request.requireText
  const canConfirm = !requireText || typedText === requireText
  busyRef.current = props.busy
  onCancelRef.current = props.onCancel

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    if (!dialog) return

    const getFocusableElements = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ))
    const initialFocus = requireText
      ? dialog.querySelector<HTMLInputElement>('input')
      : dialog.querySelector<HTMLButtonElement>('.secondary-action')
    initialFocus?.focus()

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault()
        onCancelRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const focusableElements = getFocusableElements()
      if (!focusableElements.length) return
      const first = focusableElements[0]
      const last = focusableElements[focusableElements.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    dialog.addEventListener('keydown', handleKeyDown)
    return () => {
      dialog.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus()
    }
  }, [requireText])

  return (
    <div className="confirm-backdrop" role="presentation">
      <section
        aria-describedby="confirm-body"
        aria-labelledby="confirm-title"
        aria-modal="true"
        className={`confirm-dialog ${props.request.intent}`}
        ref={dialogRef}
        role="dialog"
      >
        <div className="confirm-icon">{props.request.intent === 'danger' ? '!' : '?'}</div>
        <div className="section-title">
          <h2 id="confirm-title">{props.request.title}</h2>
          <p id="confirm-body">{props.request.body}</p>
        </div>

        {props.request.details && (
          <ul className="confirm-details">
            {props.request.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        )}

        {requireText && (
          <label>
            <span>{props.request.requireTextLabel || `输入 ${requireText}`}</span>
            <input
              autoFocus
              placeholder={requireText}
              value={typedText}
              onChange={(event) => setTypedText(event.target.value)}
            />
          </label>
        )}

        <div className="confirm-actions">
          <button className="secondary-action" disabled={props.busy} onClick={props.onCancel} type="button">
            取消
          </button>
          <button
            className={props.request.intent === 'danger' ? 'danger' : 'primary-action'}
            disabled={props.busy || !canConfirm}
            onClick={props.onConfirm}
            type="button"
          >
            {props.request.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  )
}

function ProfileForm(props: {
  apiKey: string
  apiBaseUrl: string
  apiProvider: ApiProvider
  apiRouteEnabled: boolean
  apiRouteModel: string
  authJsonPath: string
  authMode: AuthMode
  busy: boolean
  mode: 'new' | 'edit'
  name: string
  valid: boolean
  onApiKeyChange: (value: string) => void
  onApiBaseUrlChange: (value: string) => void
  onApiProviderChange: (value: ApiProvider) => void
  onApiRouteEnabledChange: (value: boolean) => void
  onApiRouteModelChange: (value: string) => void
  onAuthJsonPathChange: (value: string) => void
  onAuthModeChange: (value: AuthMode) => void
  onCancel: () => void
  onChooseAuthJsonFile: () => void
  onNameChange: (value: string) => void
  onSave: () => void
  onTest: () => void
}) {
  const canTest = props.authMode === 'account' ? Boolean(props.authJsonPath.trim()) : Boolean(props.apiKey.trim())
  return (
    <div className="form-shell">
      <div className="section-title">
        <h2>{props.mode === 'new' ? '新建 Profile' : '编辑 Profile'}</h2>
      </div>

      <label>
        <span>名称</span>
        <input placeholder="例如 personal / work" value={props.name} onChange={(event) => props.onNameChange(event.target.value)} />
      </label>

      <div className="field-block">
        <span>登录方式</span>
        <div className="login-option-grid">
          <button className={`login-option ${props.authMode === 'account' ? 'active' : ''}`} onClick={() => props.onAuthModeChange('account')} type="button">
            <strong>账号登录</strong>
            <small>创建后在 Codex 中登录</small>
          </button>
          <button className={`login-option ${props.authMode === 'apiKey' ? 'active' : ''}`} onClick={() => props.onAuthModeChange('apiKey')} type="button">
            <strong>API Key</strong>
            <small>支持 OpenAI 与第三方 OpenAI-compatible 服务</small>
          </button>
        </div>
      </div>

      {props.authMode === 'account' ? (
        <div className="field-block route-card">
          <span>导入已有 auth.json（可选）</span>
          <div className="path-picker">
            <input placeholder="选择或粘贴 auth.json 文件路径" value={props.authJsonPath} onChange={(event) => props.onAuthJsonPathChange(event.target.value)} />
            <button className="secondary-action" disabled={props.busy} onClick={props.onChooseAuthJsonFile} type="button">
              选择文件
            </button>
          </div>
          <p className="hint">无需手动配置。留空创建后，点击“登录此 Profile”并在 Codex 中完成登录。</p>
        </div>
      ) : (
        <div className="route-card">
          <div className="field-block no-margin">
            <span>API 提供商</span>
            <div className="provider-grid">
              {(Object.keys(API_PROVIDER_PRESETS) as ApiProvider[]).map((provider) => {
                const preset = API_PROVIDER_PRESETS[provider]
                return (
                  <button className={`provider-option ${props.apiProvider === provider ? 'active' : ''}`} key={provider} onClick={() => props.onApiProviderChange(provider)} type="button">
                    <strong>{preset.label}</strong>
                    <small>{preset.hint}</small>
                  </button>
                )
              })}
            </div>
          </div>
          <label>
            <span>API Key</span>
            <input type="password" placeholder="粘贴所选提供商的 API Key" value={props.apiKey} onChange={(event) => props.onApiKeyChange(event.target.value)} />
          </label>
          <label>
            <span>Base URL</span>
            <input placeholder="https://api.openai.com/v1" value={props.apiBaseUrl} onChange={(event) => props.onApiBaseUrlChange(event.target.value)} />
          </label>
          {props.apiRouteEnabled && (
            <label>
              <span>模型名</span>
              <input placeholder="供应商模型名或映射后的 GPT 名称" value={props.apiRouteModel} onChange={(event) => props.onApiRouteModelChange(event.target.value)} />
            </label>
          )}
          <p className="hint">选择 MiniMax、DeepSeek 会自动启用第三方路由并写入 Codex 自定义 provider；自定义时可手动填写 Base URL 和模型名。</p>
        </div>
      )}

      <div className="actions">
        <button className="primary-action" disabled={props.busy || !props.valid} onClick={props.onSave} type="button">
          {props.mode === 'new' ? '创建 Profile' : '保存修改'}
        </button>
        <button className="secondary-action" disabled={props.busy || !canTest} onClick={props.onTest} type="button">
          测试连通
        </button>
        <button className="secondary-action" disabled={props.busy} onClick={props.onCancel} type="button">
          取消
        </button>
      </div>
    </div>
  )
}

function ProfileDetail(props: {
  busy: boolean
  inspection: ProfileInspection | null
  instances: CodexInstance[]
  profile: Profile
  onDelete: () => void
  onEdit: () => void
  onLaunch: () => void
  onTest: () => void
  onReveal: () => void
  onStop: (pid: number) => void
}) {
  return (
    <div className="form-shell">
      <div className="panel-header">
        <div className="section-title">
          <h2>{props.profile.name}</h2>
        </div>
        <button className="secondary-action" disabled={props.busy} onClick={props.onEdit} type="button">
          编辑
        </button>
      </div>

      <dl className="facts">
        <div>
          <dt>托管目录</dt>
          <dd>{props.profile.homePath}</dd>
        </div>
        <div>
          <dt>登录方式</dt>
          <dd>{props.profile.authMode === 'apiKey' ? 'API Key 登录' : '账号登录'}</dd>
        </div>
        {props.profile.authMode === 'account' && (
          <div>
            <dt>登录状态</dt>
            <dd>{props.inspection?.hasAuthJson ? '已登录' : '待登录'}</dd>
          </div>
        )}
      </dl>

      <div className="actions">
        <button className="primary-action" disabled={props.busy} onClick={props.onLaunch} type="button">
          {props.profile.authMode === 'account' && !props.inspection?.hasAuthJson ? '登录此 Profile' : '用此 Profile 启动 Codex'}
        </button>
        <button className="secondary-action" disabled={props.busy} onClick={props.onTest} type="button">
          测试连通
        </button>
        <button className="secondary-action" disabled={props.busy} onClick={props.onReveal} type="button">
          打开托管目录
        </button>
        <button className="danger" disabled={props.busy} onClick={props.onDelete} type="button">
          删除 Profile
        </button>
      </div>
      {props.instances.length > 0 && (
        <section className="instance-list">
          <h3>运行中的实例</h3>
          {props.instances.map((instance) => (
            <div className="instance-row" key={instance.pid}>
              <span>PID {instance.pid}</span>
              <time>{new Date(instance.startedAt).toLocaleString()}</time>
              <button className="danger compact" disabled={props.busy} onClick={() => props.onStop(instance.pid)} type="button">
                停止
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).has('widget') ? <TaskWidget /> : <App />}
  </React.StrictMode>,
)
