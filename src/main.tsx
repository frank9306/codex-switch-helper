import React, { useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'
import './style.css'

type AuthMode = 'account' | 'apiKey'
type EnvironmentMode = 'shared' | 'sandbox'
type Mode = 'detail' | 'new' | 'edit'

type Profile = {
  id: string
  name: string
  homePath: string
  importSourcePath?: string
  environmentMode: EnvironmentMode
  authMode: AuthMode
  apiKey?: string
  managed: boolean
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
}

type AppSettings = {
  codexAppId: string
  envKey: string
  deleteOpenAiApiKeyBeforeLaunch: boolean
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

function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [mode, setMode] = useState<Mode>('detail')
  const [formName, setFormName] = useState('')
  const [formSourcePath, setFormSourcePath] = useState('')
  const [formEnvironmentMode, setFormEnvironmentMode] = useState<EnvironmentMode>('shared')
  const [formAuthMode, setFormAuthMode] = useState<AuthMode>('account')
  const [formApiKey, setFormApiKey] = useState('')
  const [codexAppId, setCodexAppId] = useState('')
  const [detectedCodexAppId, setDetectedCodexAppId] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [inspection, setInspection] = useState<ProfileInspection | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateProgress, setUpdateProgress] = useState('')

  async function loadState() {
    const nextState = await invoke<AppState>('get_app_state')
    setState(nextState)
    setCodexAppId(nextState.settings.codexAppId)
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

      const confirmed = window.confirm(
        `发现新版本 ${update.version}。是否现在下载并安装？安装完成后应用会重启。`,
      )
      if (!confirmed) return

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

  function startNewProfile() {
    setMode('new')
    setFormName('')
    setFormSourcePath('')
    setFormEnvironmentMode('shared')
    setFormAuthMode('account')
    setFormApiKey('')
    setMessage('')
  }

  function startEditProfile(profile: Profile) {
    setMode('edit')
    setFormName(profile.name)
    setFormSourcePath(profile.importSourcePath || '')
    setFormEnvironmentMode(profile.environmentMode || 'sandbox')
    setFormAuthMode(profile.authMode || 'account')
    setFormApiKey(profile.apiKey || '')
    setMessage('')
  }

  function showProfile(profileId: string) {
    setSelectedProfileId(profileId)
    setMode('detail')
    setMessage('')
  }

  async function chooseSourceDirectory() {
    setMessage('')
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择导入源目录',
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

  async function saveProfileForm() {
    await runAction(async () => {
      if (mode === 'new') {
        const profile = await invoke<Profile>('create_profile', {
          name: formName,
          sourcePath: formSourcePath,
          authMode: formAuthMode,
          apiKey: formAuthMode === 'apiKey' ? formApiKey : null,
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
      })
      setSelectedProfileId(profile.id)
      setMode('detail')
      return `已保存 Profile：${profile.name}`
    })
  }

  async function launchProfile(profileId: string) {
    const profile = state?.profiles.find((item) => item.id === profileId)
    await runAction(async () => {
      await invoke('launch_codex', { profileId })
      return profile?.environmentMode === 'shared'
        ? '已写回此 Profile 的登录数据和配置，并使用共享 Home 启动 Codex。'
        : '已按当前 Profile 设置 CODEX_HOME 和 OPENAI_API_KEY，并启动 Codex。'
    })
  }

  async function launchDefaultCodex() {
    await runAction(async () => {
      await invoke('launch_default_codex')
      return '已按当前系统环境默认启动 Codex，未修改 CODEX_HOME 或 OPENAI_API_KEY。'
    })
  }

  async function restoreDefaultHome() {
    const confirmed = window.confirm('确认删除用户级 CODEX_HOME？之后手动启动 Codex 会回到默认 Home，例如 C:\\Users\\frank\\.codex。')
    if (!confirmed) return

    await runAction(async () => {
      await invoke('clear_codex_home')
      setSelectedProfileId('')
      return '已清除用户级 CODEX_HOME。手动启动 Codex 将使用默认 Home。'
    })
  }

  async function saveSettings() {
    await runAction(async () => {
      await invoke('save_settings', {
        settings: {
          codexAppId,
          envKey: 'CODEX_HOME',
          deleteOpenAiApiKeyBeforeLaunch: false,
        },
      })
      return '高级设置已保存。'
    })
  }

  async function revealProfile(profileId: string) {
    await runAction(async () => {
      await invoke('reveal_profile_folder', { profileId })
    })
  }

  async function deleteProfile(profile: Profile) {
    const confirmed = window.confirm(
      profile.environmentMode === 'sandbox'
        ? `确认删除 Profile「${profile.name}」？会删除本工具托管的 Home 目录，不会删除原始导入目录。`
        : `确认删除 Profile「${profile.name}」？只会删除本工具保存的登录数据，不会删除默认 Codex Home。`,
    )
    if (!confirmed) return

    await runAction(async () => {
      await invoke('delete_profile', { profileId: profile.id })
      setMode('detail')
      setSelectedProfileId('')
      return `已删除 Profile：${profile.name}`
    })
  }

  if (!state) {
    return <main className="shell">加载中...</main>
  }

  const formIsValid =
    formName.trim() &&
    (mode === 'edit' ||
      (formEnvironmentMode === 'shared' && formAuthMode === 'apiKey') ||
      formSourcePath.trim()) &&
    (formAuthMode === 'account' || formApiKey.trim())
  const sharedProfiles = state.profiles.filter((profile) => profile.environmentMode === 'shared').length
  const sandboxProfiles = state.profiles.filter((profile) => (profile.environmentMode || 'sandbox') === 'sandbox').length
  const accountProfiles = state.profiles.filter((profile) => profile.authMode === 'account').length
  const apiKeyProfiles = state.profiles.filter((profile) => profile.authMode === 'apiKey').length
  const activeProfile = state.profiles.find((profile) => profile.id === state.activeProfileId)
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
        <button className="rail-item active" type="button" aria-label="Profiles">🚀</button>
        <button className="rail-item" type="button" aria-label="Dashboard">◎</button>
        <button className="rail-item" type="button" aria-label="Settings" onClick={() => setAdvancedOpen((value) => !value)}>⚙</button>
      </aside>

      <section className="dashboard">
        <section className="topbar">
          <div className="brand-lockup">
            <span className="brand-mark">C</span>
            <div>
              <p className="eyebrow">Codex Switch Helper</p>
              <h1>仪表盘</h1>
            </div>
          </div>
          <div className="header-actions">
            <button className="secondary-action" disabled={busy} onClick={restoreDefaultHome} type="button">
              恢复默认 Home
            </button>
            <button className="primary-action" disabled={busy} onClick={launchDefaultCodex} type="button">
              默认启动 Codex
            </button>
          </div>
        </section>

        {message && <div className="message">{message}</div>}

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

            <div className="profile-stack">
              {state.profiles.map((profile) => (
                <button
                  className={`profile-item ${profile.id === selectedProfileId && mode === 'detail' ? 'active' : ''}`}
                  key={profile.id}
                  onClick={() => showProfile(profile.id)}
                  type="button"
                >
                  <span className="profile-avatar">{(profile.name || 'C').slice(0, 1).toUpperCase()}</span>
                  <span className="profile-copy">
                    <strong>{profile.name}</strong>
                    <small>{profile.homePath}</small>
                  </span>
                  <span className="profile-badges">
                    <em>{(profile.environmentMode || 'sandbox') === 'sandbox' ? '沙盒' : '共享'}</em>
                    {profile.id === state.activeProfileId && <em className="hot">当前</em>}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <section className="panel workspace-panel">
            {mode === 'new' || mode === 'edit' ? (
              <ProfileForm
                apiKey={formApiKey}
                authMode={formAuthMode}
                busy={busy}
                mode={mode}
                name={formName}
                sourcePath={formSourcePath}
                environmentMode={formEnvironmentMode}
                onApiKeyChange={setFormApiKey}
                onAuthModeChange={setFormAuthMode}
                onCancel={() => setMode('detail')}
                onChooseDirectory={chooseSourceDirectory}
                onNameChange={setFormName}
                onEnvironmentModeChange={setFormEnvironmentMode}
                onSave={saveProfileForm}
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

          <section className="panel settings-panel">
            <div className="update-card">
              <div className="section-title">
                <h2>应用更新</h2>
                <p>当前版本：{appVersion || '未知'}。启动时会自动检查一次，也可以手动检查。</p>
              </div>
              {updateProgress && <p className="hint">{updateProgress}</p>}
              <button className="secondary-action full-width" disabled={updateBusy} onClick={() => checkForUpdate(false)} type="button">
                {updateBusy ? '检查中...' : '检查更新'}
              </button>
            </div>

            <button className="advanced-toggle" onClick={() => setAdvancedOpen((value) => !value)} type="button">
              高级设置
              <span>{advancedOpen ? '收起' : '展开'}</span>
            </button>

            {advancedOpen && (
              <div className="advanced-body">
                <div className="section-title">
                  <h2>Codex App 启动</h2>
                  <p>AppID 会自动扫描。扫描不到或启动失败时，再手动修改。</p>
                </div>
                <label>
                  <span>Codex AppID</span>
                  <input value={codexAppId} onChange={(event) => setCodexAppId(event.target.value)} />
                </label>
                <p className="hint">自动扫描结果：{detectedCodexAppId || '未检测到'}</p>
                <p className="hint">OPENAI_API_KEY 由每个 Profile 的登录方式自动处理，账号登录会清除，API Key 登录会写入。</p>
                <button className="secondary-action full-width" disabled={busy || !codexAppId.trim()} onClick={saveSettings} type="button">
                  保存高级设置
                </button>
              </div>
            )}
          </section>
        </section>
      </section>
    </main>
  )
}

function ProfileForm(props: {
  apiKey: string
  authMode: AuthMode
  busy: boolean
  environmentMode: EnvironmentMode
  mode: 'new' | 'edit'
  name: string
  sourcePath: string
  valid: boolean
  onApiKeyChange: (value: string) => void
  onAuthModeChange: (value: AuthMode) => void
  onCancel: () => void
  onChooseDirectory: () => void
  onEnvironmentModeChange: (value: EnvironmentMode) => void
  onNameChange: (value: string) => void
  onSave: () => void
  onSourcePathChange: (value: string) => void
}) {
  return (
    <div className="form-shell">
      <div className="section-title">
        <h2>{props.mode === 'new' ? '新建 Profile' : '编辑 Profile'}</h2>
        <p>{props.mode === 'new' ? '默认只保存登录数据，共享默认 Codex Home；沙盒模式才复制完整环境。' : '编辑名称和登录方式。环境模式创建后不在这里修改。'}</p>
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
          <p className="hint">共享环境共用同一个 Codex Home，启动时写回登录数据和配置；沙盒模式复制完整环境并隔离启动。</p>
        </div>
      )}

      {props.mode === 'new' && (
        <div className="field-block">
          <span>{props.environmentMode === 'shared' && props.authMode === 'apiKey' ? '导入源目录（可选）' : '导入源目录'}</span>
          <div className="path-picker">
            <input placeholder="选择一个已有 Codex Home 目录" value={props.sourcePath} onChange={(event) => props.onSourcePathChange(event.target.value)} />
            <button className="secondary-action" disabled={props.busy} onClick={props.onChooseDirectory} type="button">
              选择目录
            </button>
          </div>
          <p className="hint">
            {props.environmentMode === 'sandbox'
              ? '源目录会被复制，之后 Profile 使用自动生成的托管目录，不会继续写入源目录。'
              : props.authMode === 'account'
                ? '账号登录需要从此目录读取并保存 auth.json，不复制其他环境文件。'
                : 'API Key 共享环境不需要导入源目录；填写后仅记录来源。'}
          </p>
        </div>
      )}

      <div className="field-block">
        <span>登录方式</span>
        <div className="segmented">
          <button className={props.authMode === 'account' ? 'active' : ''} onClick={() => props.onAuthModeChange('account')} type="button">
            账号登录
          </button>
          <button className={props.authMode === 'apiKey' ? 'active' : ''} onClick={() => props.onAuthModeChange('apiKey')} type="button">
            API Key 登录
          </button>
        </div>
        <p className="hint">账号登录会保存并写回 auth.json；API Key 登录会写入本 Profile 的 key。</p>
      </div>

      {props.authMode === 'apiKey' && (
        <label>
          <span>OPENAI_API_KEY</span>
          <input type="password" placeholder="sk-..." value={props.apiKey} onChange={(event) => props.onApiKeyChange(event.target.value)} />
        </label>
      )}

      <div className="actions">
        <button className="primary-action" disabled={props.busy || !props.valid} onClick={props.onSave} type="button">
          {props.mode === 'new' ? '创建 Profile' : '保存修改'}
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
        <div>
          <dt>导入来源</dt>
          <dd>{props.profile.importSourcePath || '旧版本 Profile，无导入来源记录'}</dd>
        </div>
        <div>
          <dt>登录方式</dt>
          <dd>{props.profile.authMode === 'apiKey' ? 'API Key 登录' : '账号登录'}</dd>
        </div>
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
