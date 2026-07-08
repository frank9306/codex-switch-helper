import React, { useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'
import './style.css'

type AuthMode = 'account' | 'apiKey'
type ApiProvider = 'openai' | 'minimax' | 'deepseek' | 'custom'
type EnvironmentMode = 'shared' | 'sandbox'
type Mode = 'detail' | 'new' | 'edit'
type ActiveMenu = 'profiles' | 'settings' | 'about'
type ProxyProtocol = 'http' | 'socks5'

type ConfirmIntent = 'danger' | 'warning'

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
  importSourcePath?: string
  environmentMode: EnvironmentMode
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

function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [mode, setMode] = useState<Mode>('detail')
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>('profiles')
  const [formName, setFormName] = useState('')
  const [formSourcePath, setFormSourcePath] = useState('')
  const [formAuthJsonPath, setFormAuthJsonPath] = useState('')
  const [formEnvironmentMode, setFormEnvironmentMode] = useState<EnvironmentMode>('shared')
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
  const [detectedCodexAppId, setDetectedCodexAppId] = useState<string | null>(null)
  const [inspection, setInspection] = useState<ProfileInspection | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateProgress, setUpdateProgress] = useState('')
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)

  async function loadState() {
    const nextState = await invoke<AppState>('get_app_state')
    setState(nextState)
    setCodexAppId(nextState.settings.codexAppId)
    setProxyEnabled(Boolean(nextState.settings.proxyEnabled))
    setProxyProtocol(nextState.settings.proxyProtocol || 'http')
    setProxyHost(nextState.settings.proxyHost || '')
    setProxyPort(nextState.settings.proxyPort || '')
    setSelectedProfileId((current) => current || nextState.activeProfileId || nextState.profiles[0]?.id || '')
  }

  async function checkForUpdate(silent = false) {
    setUpdateBusy(true)
    setUpdateProgress('')
    if (!silent) setMessage('')

    try {
      const update = await check()
      if (!update) {
        if (!silent) setMessage('当前已是最新版本。')
        return
      }

      setUpdateBusy(false)
      requestConfirm({
        title: `安装更新：${update.version}`,
        body: '安装完成后应用会自动重启。',
        confirmLabel: '下载并安装',
        intent: 'warning',
        details: ['下载更新包', '安装新版本', '重启应用'],
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
            setMessage(`安装更新失败：${String(error)}`)
          } finally {
            setUpdateBusy(false)
          }
        },
      })
    } catch (error) {
      if (!silent) setMessage(`检查更新失败：${String(error)}`)
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
      .then(async () => {
        getVersion().then(setAppVersion).catch(() => setAppVersion(''))
        const nextState = await invoke<AppState>('get_app_state')
        await detectAndSaveCodexAppId(nextState.settings)
        await checkForUpdate(true)
      })
      .catch((error) => setMessage(String(error)))
  }, [])

  useEffect(() => {
    if (!selectedProfileId || mode !== 'detail') {
      setInspection(null)
      return
    }
    invoke<ProfileInspection>('inspect_profile', { profileId: selectedProfileId })
      .then(setInspection)
      .catch((error) => setMessage(String(error)))
  }, [selectedProfileId, mode])

  const selectedProfile = state?.profiles.find((profile) => profile.id === selectedProfileId)


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
    setFormSourcePath('')
    setFormAuthJsonPath('')
    setFormEnvironmentMode('shared')
    setFormAuthMode('account')
    setFormApiKey('')
    applyApiProviderPreset('openai')
    setMessage('')
  }

  function startEditProfile(profile: Profile) {
    setActiveMenu('profiles')
    setMode('edit')
    setFormName(profile.name)
    setFormSourcePath(profile.importSourcePath || '')
    setFormAuthJsonPath('')
    setFormEnvironmentMode(profile.environmentMode || 'sandbox')
    setFormAuthMode(profile.authMode || 'account')
    setFormApiKey(profile.apiKey || '')
    setFormApiProvider(profile.apiProvider || 'custom')
    setFormApiBaseUrl(profile.apiBaseUrl || API_PROVIDER_PRESETS[profile.apiProvider || 'openai'].baseUrl)
    setFormApiRouteEnabled(Boolean(profile.apiRouteEnabled))
    setFormApiRouteModel(profile.apiRouteModel || API_PROVIDER_PRESETS[profile.apiProvider || 'openai'].model)
    setMessage('')
  }

  function showProfile(profileId: string) {
    setActiveMenu('profiles')
    setSelectedProfileId(profileId)
    setMode('detail')
    setMessage('')
  }

  async function chooseAuthJsonFile() {
    setMessage('')
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
      setMessage(String(error))
    }
  }

  async function chooseSourceDirectory() {
    setMessage('')
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择 Codex Home 目录',
      })
      if (typeof selected === 'string') {
        setFormSourcePath(selected)
      }
    } catch (error) {
      setMessage(String(error))
    }
  }

  async function runAction(action: () => Promise<string | void>) {
    setBusy(true)
    setMessage('')
    try {
      const result = await action()
      if (result) setMessage(result)
      await loadState()
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
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
          sourcePath: formSourcePath,
          authMode: formAuthMode,
          apiKey: formAuthMode === 'apiKey' ? formApiKey : null,
          authJsonPath: formAuthMode === 'account' ? formAuthJsonPath : null,
          apiProvider: formAuthMode === 'apiKey' ? formApiProvider : null,
          apiBaseUrl: formAuthMode === 'apiKey' ? formApiBaseUrl : null,
          apiRouteEnabled: formAuthMode === 'apiKey' ? formApiRouteEnabled : false,
          apiRouteModel: formAuthMode === 'apiKey' ? formApiRouteModel : null,
          environmentMode: formEnvironmentMode,
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
    })
  }


  async function testProfile(profileId: string) {
    await runAction(async () => {
      const result = await invoke<ConnectionTestResult>('test_profile_connection', { profileId })
      return result.ok ? `连通测试通过：${result.endpoint}` : `连通测试失败：HTTP ${result.status}，${result.endpoint}`
    })
  }

  async function testLoginForm() {
    await runAction(async () => {
      const result = await invoke<ConnectionTestResult>('test_login_connection', {
        authMode: formAuthMode,
        apiKey: formAuthMode === 'apiKey' ? formApiKey : null,
        authJsonPath: formAuthMode === 'account' ? formAuthJsonPath : null,
        sourcePath: formSourcePath,
        apiBaseUrl: formAuthMode === 'apiKey' ? formApiBaseUrl : null,
      })
      return result.ok ? `连通测试通过：${result.endpoint}` : `连通测试失败：HTTP ${result.status}，${result.endpoint}`
    })
  }

  async function launchProfile(profileId: string) {
    const profile = state?.profiles.find((item) => item.id === profileId)
    requestConfirm({
      title: `启动 Profile：${profile?.name || '未知'}`,
      body: '此操作会修改当前用户环境并启动 Codex。',
      confirmLabel: '确认启动',
      intent: 'warning',
      details: proxyEnabled
        ? ['写入 CODEX_HOME', '切换登录状态或 OPENAI_API_KEY', '写入代理环境变量']
        : ['写入 CODEX_HOME', '切换登录状态或 OPENAI_API_KEY', '清理本工具管理的代理环境变量'],
      onConfirm: async () => {
        await runAction(async () => {
          await invoke('launch_codex', { profileId })
          return profile?.environmentMode === 'shared'
            ? '已写回此 Profile 的登录数据和配置，并使用共享 Home 启动 Codex。'
            : '已按当前 Profile 设置 CODEX_HOME 和 OPENAI_API_KEY，并启动 Codex。'
        })
      },
    })
  }

  async function launchDefaultCodex() {
    requestConfirm({
      title: '默认启动 Codex',
      body: '此操作不会修改 CODEX_HOME 或 OPENAI_API_KEY，但会同步当前代理设置。',
      confirmLabel: '确认启动',
      intent: 'warning',
      details: proxyEnabled ? ['写入代理环境变量', '启动 Codex'] : ['清理本工具管理的代理环境变量', '启动 Codex'],
      onConfirm: async () => {
        await runAction(async () => {
          await invoke('launch_default_codex')
          return proxyEnabled
            ? '已按当前系统环境默认启动 Codex，并应用代理设置；未修改 CODEX_HOME 或 OPENAI_API_KEY。'
            : '已按当前系统环境默认启动 Codex，并清理本工具管理的代理环境变量；未修改 CODEX_HOME 或 OPENAI_API_KEY。'
        })
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
        })
      },
    })
  }

  async function saveSettings() {
    requestConfirm({
      title: '保存设置',
      body: '这些设置会影响本程序网络请求和后续 Codex 启动方式。',
      confirmLabel: '保存设置',
      intent: 'warning',
      details: proxyEnabled
        ? [`本程序立即使用代理：${proxyProtocol}://${proxyHost}:${proxyPort}`, '后续启动 Codex 时同步代理环境变量']
        : ['本程序立即停止使用代理', '后续启动 Codex 时清理本工具管理的代理环境变量'],
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
            },
          })
          return '设置已保存。'
        })
      },
    })
  }

  async function revealProfile(profileId: string) {
    await runAction(async () => {
      await invoke('reveal_profile_folder', { profileId })
    })
  }

  async function deleteProfile(profile: Profile) {
    requestConfirm({
      title: `删除 Profile：${profile.name}`,
      body: '删除操作不可撤销。请输入 Profile 名称后才能继续。',
      confirmLabel: '删除 Profile',
      intent: 'danger',
      requireText: profile.name,
      requireTextLabel: `输入 ${profile.name}`,
      details:
        profile.environmentMode === 'sandbox'
          ? ['删除本工具保存的 Profile 记录', '删除本工具托管的 Home 目录', '不会删除原始导入目录']
          : ['删除本工具保存的 Profile 记录', '不会删除默认 Codex Home'],
      onConfirm: async () => {
        await runAction(async () => {
          await invoke('delete_profile', { profileId: profile.id })
          setMode('detail')
          setSelectedProfileId('')
          return `已删除 Profile：${profile.name}`
        })
      },
    })
  }

  if (!state) {
    return <main className="shell">加载中...</main>
  }

  const formIsValid =
    formName.trim() &&
    (mode === 'edit' || formEnvironmentMode === 'shared' || formSourcePath.trim()) &&
    (formAuthMode === 'account' || formApiKey.trim()) &&
    (!formApiRouteEnabled || (formApiBaseUrl.trim() && formApiRouteModel.trim()))
  const sharedProfiles = state.profiles.filter((profile) => profile.environmentMode === 'shared').length
  const sandboxProfiles = state.profiles.filter((profile) => (profile.environmentMode || 'sandbox') === 'sandbox').length
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
    { label: '账号总数', value: state.profiles.length, icon: '👥', tone: 'blue' },
    { label: '共享环境', value: sharedProfiles, icon: '↔', tone: 'green' },
    { label: '沙盒环境', value: sandboxProfiles, icon: '◎', tone: 'cyan' },
    { label: '账号登录', value: accountProfiles, icon: '◆', tone: 'purple' },
    { label: 'API Key', value: apiKeyProfiles, icon: '⌁', tone: 'mint' },
  ]

  return (
    <main className="shell">
      <aside className="side-rail" aria-label="主导航">
        <span className="rail-dot rail-close" />
        <span className="rail-dot rail-minimize" />
        <span className="rail-dot rail-zoom" />
        <button
          className={`rail-item ${activeMenu === 'profiles' ? 'active' : ''}`}
          type="button"
          aria-label="Profiles"
          onClick={() => setActiveMenu('profiles')}
        >
          🚀
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
              <h1>{activeMenu === 'about' ? '关于' : activeMenu === 'settings' ? '设置' : '仪表盘'}</h1>
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

        {message && <div className="message">{message}</div>}

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
                    const isSandbox = (profile.environmentMode || 'sandbox') === 'sandbox'
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
                            <em>{isSandbox ? '沙盒' : '共享'}</em>
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
                    sourcePath={formSourcePath}
                    environmentMode={formEnvironmentMode}
                    onApiKeyChange={setFormApiKey}
                    onAuthModeChange={setFormAuthMode}
                    onApiBaseUrlChange={setFormApiBaseUrl}
                    onApiProviderChange={applyApiProviderPreset}
                    onApiRouteEnabledChange={setFormApiRouteEnabled}
                    onApiRouteModelChange={setFormApiRouteModel}
                    onAuthJsonPathChange={setFormAuthJsonPath}
                    onCancel={() => setMode('detail')}
                    onChooseAuthJsonFile={chooseAuthJsonFile}
                    onChooseDirectory={chooseSourceDirectory}
                    onNameChange={setFormName}
                    onEnvironmentModeChange={setFormEnvironmentMode}
                    onSave={saveProfileForm}
                    onTest={testLoginForm}
                    onSourcePathChange={setFormSourcePath}
                    valid={Boolean(formIsValid)}
                  />
                ) : selectedProfile ? (
                  <ProfileDetail
                    busy={busy}
                    inspection={inspection}
                    profile={selectedProfile}
                    onDelete={() => deleteProfile(selectedProfile)}
                    onEdit={() => startEditProfile(selectedProfile)}
                    onLaunch={() => launchProfile(selectedProfile.id)}
                    onTest={() => testProfile(selectedProfile.id)}
                    onReveal={() => revealProfile(selectedProfile.id)}
                  />
                ) : (
                  <div className="empty-state">
                    <h2>选择或新建一个 Profile</h2>
                    <p>新建时默认只保存登录数据并共享默认 Codex Home；需要隔离时可选择沙盒模式。</p>
                    <button className="primary-action" onClick={startNewProfile} type="button">
                      新建 Profile
                    </button>
                  </div>
                )}
              </section>
            </section>
          </>
        ) : activeMenu === 'settings' ? (
          <section className="settings-grid">
            <section className="panel settings-form-panel">
              <div className="section-title">
                <h2>代理</h2>
                <p>保存后本程序会立即使用代理；启动 Codex 前也会写入用户级 HTTP_PROXY、HTTPS_PROXY 和 ALL_PROXY。</p>
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
    </main>
  )
}

function ConfirmDialog(props: {
  busy: boolean
  request: ConfirmRequest
  onCancel: () => void
  onConfirm: () => void
}) {
  const [typedText, setTypedText] = useState('')
  const requireText = props.request.requireText
  const canConfirm = !requireText || typedText === requireText

  return (
    <div className="confirm-backdrop" role="presentation">
      <section
        aria-describedby="confirm-body"
        aria-labelledby="confirm-title"
        aria-modal="true"
        className={`confirm-dialog ${props.request.intent}`}
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
  environmentMode: EnvironmentMode
  mode: 'new' | 'edit'
  name: string
  sourcePath: string
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
  onChooseDirectory: () => void
  onEnvironmentModeChange: (value: EnvironmentMode) => void
  onNameChange: (value: string) => void
  onSave: () => void
  onSourcePathChange: (value: string) => void
  onTest: () => void
}) {
  const canTest = props.authMode === 'account' ? true : Boolean(props.apiKey.trim())
  return (
    <div className="form-shell">
      <div className="section-title">
        <h2>{props.mode === 'new' ? '新建 Profile' : '编辑 Profile'}</h2>
        <p>{props.mode === 'new' ? '选择账号登录或 API Key 登录；API Key 可绑定第三方 OpenAI-compatible 路由。' : '编辑名称、登录凭据和第三方路由。环境模式创建后不在这里修改。'}</p>
      </div>

      <label>
        <span>名称</span>
        <input placeholder="例如 personal / work" value={props.name} onChange={(event) => props.onNameChange(event.target.value)} />
      </label>

      {props.mode === 'new' && (
        <div className="field-block">
          <span>环境模式</span>
          <div className="segmented">
            <button className={props.environmentMode === 'shared' ? 'active' : ''} onClick={() => props.onEnvironmentModeChange('shared')} type="button">
              共享环境
            </button>
            <button className={props.environmentMode === 'sandbox' ? 'active' : ''} onClick={() => props.onEnvironmentModeChange('sandbox')} type="button">
              沙盒模式
            </button>
          </div>
          <p className="hint">共享环境只切换身份和配置；沙盒模式复制完整 Codex Home 并隔离启动。</p>
        </div>
      )}

      <div className="field-block">
        <span>登录方式</span>
        <div className="login-option-grid">
          <button className={`login-option ${props.authMode === 'account' ? 'active' : ''}`} onClick={() => props.onAuthModeChange('account')} type="button">
            <strong>账号登录</strong>
            <small>{props.environmentMode === 'shared' ? '直接使用所选 Home 中的账号态' : '可导入 auth.json 作为账号态'}</small>
          </button>
          <button className={`login-option ${props.authMode === 'apiKey' ? 'active' : ''}`} onClick={() => props.onAuthModeChange('apiKey')} type="button">
            <strong>API Key</strong>
            <small>支持 OpenAI 与第三方 OpenAI-compatible 服务</small>
          </button>
        </div>
      </div>

      {props.authMode === 'account' ? (
        <div className="field-block route-card">
          <span>auth.json 文件</span>
          <div className="path-picker">
            <input placeholder="选择或粘贴 auth.json 文件路径" value={props.authJsonPath} onChange={(event) => props.onAuthJsonPathChange(event.target.value)} />
            <button className="secondary-action" disabled={props.busy} onClick={props.onChooseAuthJsonFile} type="button">
              选择文件
            </button>
          </div>
          <p className="hint">共享模式可留空，启动时直接使用所选 Home 的 auth.json；选择文件时会保存一份账号态快照。</p>
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

      {props.mode === 'new' && (
        <div className="field-block">
          <span>{props.environmentMode === 'shared' ? 'Codex Home（可选）' : '导入源目录'}</span>
          <div className="path-picker">
            <input placeholder="选择一个已有 Codex Home 目录" value={props.sourcePath} onChange={(event) => props.onSourcePathChange(event.target.value)} />
            <button className="secondary-action" disabled={props.busy} onClick={props.onChooseDirectory} type="button">
              选择目录
            </button>
          </div>
          <p className="hint">
            {props.environmentMode === 'sandbox'
              ? '沙盒模式仍需要源目录，源目录会被复制到工具托管 Home。'
              : '共享模式不会复制或导入此目录；它就是启动时写入 CODEX_HOME 的目标 Home。留空则使用默认 ~/.codex。'}
          </p>
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
  profile: Profile
  inspection: ProfileInspection | null
  onDelete: () => void
  onEdit: () => void
  onLaunch: () => void
  onTest: () => void
  onReveal: () => void
}) {
  const isSandbox = (props.profile.environmentMode || 'sandbox') === 'sandbox'
  return (
    <div className="form-shell">
      <div className="panel-header">
        <div className="section-title">
          <h2>{props.profile.name}</h2>
          <p>{isSandbox ? '当前选中的沙盒 Codex Home 配置。' : '当前选中的共享环境登录配置。'}</p>
        </div>
        <button className="secondary-action" disabled={props.busy} onClick={props.onEdit} type="button">
          编辑
        </button>
      </div>

      <dl className="facts">
        <div>
          <dt>{isSandbox ? '托管 Codex Home' : '默认 Codex Home'}</dt>
          <dd>{props.profile.homePath}</dd>
        </div>
        <div>
          <dt>环境模式</dt>
          <dd>{isSandbox ? '沙盒模式' : '共享环境'}</dd>
        </div>
        {isSandbox && (
          <div>
            <dt>导入来源</dt>
            <dd>{props.profile.importSourcePath || '旧版本 Profile，无导入来源记录'}</dd>
          </div>
        )}
        <div>
          <dt>登录方式</dt>
          <dd>{props.profile.authMode === 'apiKey' ? 'API Key 登录' : '账号登录'}</dd>
        </div>
        {props.profile.authMode === 'apiKey' && (
          <>
            <div>
              <dt>提供商</dt>
              <dd>{API_PROVIDER_PRESETS[props.profile.apiProvider || 'custom']?.label || '自定义'}</dd>
            </div>
            <div>
              <dt>Base URL</dt>
              <dd>{props.profile.apiBaseUrl || 'https://api.openai.com/v1'}</dd>
            </div>
            <div>
              <dt>第三方路由</dt>
              <dd>{props.profile.apiRouteEnabled ? `已启用，模型 ${props.profile.apiRouteModel || '-'}` : '未启用'}</dd>
            </div>
          </>
        )}
        <div>
          <dt>auth.json</dt>
          <dd>{props.inspection?.hasAuthJson ? '存在' : '未发现'}</dd>
        </div>
        <div>
          <dt>config.toml</dt>
          <dd>{props.inspection?.hasConfigToml ? '存在' : '未发现'}</dd>
        </div>
        <div>
          <dt>文件数量</dt>
          <dd>{props.inspection?.fileCount ?? '-'}</dd>
        </div>
      </dl>

      <div className="actions">
        <button className="primary-action" disabled={props.busy} onClick={props.onLaunch} type="button">
          用此 Profile 启动 Codex
        </button>
        <button className="secondary-action" disabled={props.busy} onClick={props.onTest} type="button">
          测试连通
        </button>
        {isSandbox && <button className="secondary-action" disabled={props.busy} onClick={props.onReveal} type="button">
          打开托管目录
        </button>}
        <button className="danger" disabled={props.busy} onClick={props.onDelete} type="button">
          删除 Profile
        </button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
