import React, { useEffect, useRef, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'
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
  skillsPaths: string[]
  skills: Array<{ name: string; path: string; source: string; shared: boolean; description?: string | null }>
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
  }>
}

type PluginSyncResult = {
  imported: number
  updated: number
  skipped: number
  conflicts: string[]
  profileErrors: string[]
}

type CodexInstance = {
  profileId: string
  profileName: string
  pid: number
  startedAt: string
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
  const codexAppIdDetectionStarted = useRef(false)
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
    if (activeMenu !== 'resources' || resources) return
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
      const [next, plugins] = await Promise.all([
        invoke<SharedResources>('get_shared_resources'),
        invoke<SharedPlugins>('get_shared_plugins'),
      ])
      setResources(next)
      setSharedPlugins(plugins)
      setAgentsDraft(next.agentsContent)
      if (notify) showNotice('共享资源已刷新', 'success')
    } catch (error) {
      showError('刷新共享资源失败', error)
    } finally {
      setBusy(false)
      setLoadingLabel('')
    }
  }

  async function importProfilePlugins() {
    await runAction(async () => {
      const result = await invoke<PluginSyncResult>('import_profile_plugins')
      setSharedPlugins(await invoke<SharedPlugins>('get_shared_plugins'))
      const detail = [
        `导入 ${result.imported}`,
        `同步 ${result.updated}`,
        `跳过 ${result.skipped}`,
        result.conflicts.length ? `冲突 ${result.conflicts.length}` : '',
        result.profileErrors.length ? `失败 ${result.profileErrors.length}` : '',
      ].filter(Boolean).join('，')
      if (result.conflicts.length || result.profileErrors.length) {
        showNotice('插件汇总完成，但有项目需要处理', 'error', [...result.conflicts, ...result.profileErrors].join('\n'))
        return
      }
      return `插件汇总完成：${detail}。`
    }, '正在汇总并同步插件...')
  }

  async function syncSharedPlugins() {
    await runAction(async () => {
      const result = await invoke<PluginSyncResult>('sync_shared_plugins')
      setSharedPlugins(await invoke<SharedPlugins>('get_shared_plugins'))
      if (result.profileErrors.length) {
        showNotice('部分 Profile 同步失败', 'error', result.profileErrors.join('\n'))
        return
      }
      return `插件同步完成：更新 ${result.updated} 个，已是最新 ${result.skipped} 个。`
    }, '正在同步共享插件...')
  }

  async function importCodexSkills() {
    await runAction(async () => {
      const result = await invoke<SkillImportResult>('import_codex_skills')
      const next = await invoke<SharedResources>('get_shared_resources')
      setResources(next)
      setAgentsDraft(next.agentsContent)
      return `Skills 导入完成：新增 ${result.imported} 个，跳过同名 ${result.skipped} 个。`
    }, '正在导入 ~/.codex/skills...')
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
            onImport={importCodexSkills}
            onImportPlugins={importProfilePlugins}
            onRefresh={() => refreshResources(true)}
            onSave={saveAgents}
            onSyncPlugins={syncSharedPlugins}
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
  onImport: () => void
  onImportPlugins: () => void
  onRefresh: () => void
  onSave: () => void
  onSyncPlugins: () => void
}) {
  const [activeResourceView, setActiveResourceView] = useState<'prompt' | 'skills' | 'plugins'>('prompt')
  const [skillQuery, setSkillQuery] = useState('')
  if (!props.resources) {
    return <section className="panel resource-loading"><LoadingIndicator label="正在读取共享资源..." /></section>
  }
  const normalizedQuery = skillQuery.trim().toLocaleLowerCase()
  const filteredSkills = props.resources.skills.filter((skill) => (
    !normalizedQuery
    || skill.name.toLocaleLowerCase().includes(normalizedQuery)
    || skill.description?.toLocaleLowerCase().includes(normalizedQuery)
    || skill.path.toLocaleLowerCase().includes(normalizedQuery)
  ))
  const skillGroups = [
    { key: 'shared', title: '全局共享', description: '~/.agents/skills，可供所有 Profile 使用', skills: filteredSkills.filter((skill) => skill.shared) },
    { key: 'legacy', title: '默认 Home', description: '~/.codex/skills，可导入全局共享目录', skills: filteredSkills.filter((skill) => !skill.shared) },
  ].filter((group) => group.skills.length > 0)

  return (
    <section className="panel resource-workspace">
      <div className="resource-workspace-toolbar">
        <div className="segmented resource-tabs" role="tablist" aria-label="共享资源类型">
          <button className={activeResourceView === 'prompt' ? 'active' : ''} onClick={() => setActiveResourceView('prompt')} role="tab" aria-selected={activeResourceView === 'prompt'} type="button">
            全局提示词
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
              <button className="secondary-action compact" disabled={props.busy} onClick={props.onImport} type="button">
                导入 ~/.codex
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
                      </div>
                      <div className="skill-detail">
                        <p>{skill.description || '未提供说明'}</p>
                        <code>{skill.path}</code>
                      </div>
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
              <button className="secondary-action compact" disabled={props.busy} onClick={props.onImportPlugins} type="button">
                汇总现有插件
              </button>
              <button className="primary-action compact" disabled={props.busy} onClick={props.onSyncPlugins} type="button">
                同步所有 Profile
              </button>
            </div>
          </div>
          <div className="skill-source-paths">
            <code>{props.plugins?.marketplacePath || '~/.agents/plugins/marketplace.json'}</code>
          </div>
          <div className="skill-groups">
            {props.plugins?.plugins.length ? (
              <section className="skill-group">
                <header className="skill-group-heading">
                  <div>
                    <h3>全局共享</h3>
                    <p>官方内置插件不在此处管理</p>
                  </div>
                  <span>{props.plugins.plugins.length}</span>
                </header>
                <div className="skill-list">
                  {props.plugins.plugins.map((plugin) => {
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
    <App />
  </React.StrictMode>,
)
