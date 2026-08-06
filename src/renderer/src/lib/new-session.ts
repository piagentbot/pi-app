import { ipcClient } from '@renderer/lib/ipc-client'
import { useUIStore } from '@renderer/stores/ui-store'
import type { SessionItem } from '@renderer/stores/ui-store-types'
import { titleFromFirstMessage } from '@renderer/lib/ephemeral-sandbox'

/** 侧栏「新会话」：仅占位，不碰 Worker */
export function enterNewSessionPlaceholder(): void {
  useUIStore.getState().enterPendingNewSessionPlaceholder()
}

/** 首条消息：创建真实 session 并刷新侧栏 */
export async function materializePendingNewSession(workspaceId: string, firstMessage: string): Promise<void> {
  if (!workspaceId) return
  const store = useUIStore.getState()

  const title = titleFromFirstMessage(firstMessage, 48) || '新会话'

  const res = await ipcClient.invoke('session.new', { workspaceId })
  const sessionId = res?.session?.sessionId
  if (!sessionId) throw new Error('session.new returned no sessionId')

  const sessionFile = res?.session?.sessionFile as string | undefined

  store.clearPendingNewSessionPlaceholder()
  store.setCurrentSession(sessionId)
  // Drop stale timeline items left over from the previously-viewed conversation:
  // while no session file was bound (home/pending view), that worker's events
  // route as visible and can repopulate the list. Keep only the trailing
  // optimistic pair just appended for this first message — the worker echoes the
  // real user message once the prompt is sent.
  const items = useUIStore.getState().timelineItems || []
  let lastOptUser = -1
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.id?.startsWith?.('opt-user-')) {
      lastOptUser = i
      break
    }
  }
  if (lastOptUser > 0) {
    useUIStore.setState({ timelineItems: items.slice(lastOptUser) })
  }
  store.clearFileChanges()
  if (sessionFile) {
    store.setHistoryMeta(0, 0, sessionFile)
    // session.new 后 Worker 已是新会话，勿 setPendingBind（否则 prompt.send 会再 loadSession 卡很久）
    await ipcClient.invoke('session.setPendingBind', { sessionFile: null }).catch(() => {})
  }

  // Apply the user's pre-selected model/thinking level to the new session.
  const { runState } = store
  if (sessionFile) {
    if (runState.model && runState.model.includes('/')) {
      const [provider, ...modelIdParts] = runState.model.split('/')
      const modelId = modelIdParts.join('/')
      const modelResult = await ipcClient.invoke('model.set', {
        sessionId: '',
        sessionFile,
        provider,
        modelId,
      })
      const requestedModel = `${provider}/${modelId}`
      if (modelResult.modelId !== requestedModel) {
        throw new Error(`Model selection was not confirmed: ${modelResult.modelId || 'unknown'}`)
      }
    }
    if (runState.thinkingLevel) {
      await ipcClient.invoke('thinkingLevel.set', {
        sessionId: '',
        sessionFile,
        level: runState.thinkingLevel,
      })
    }
  }

  const { refreshComposerRunDisplay } = await import('@renderer/lib/composer-run-display')
  void refreshComposerRunDisplay()

  const listRes = await ipcClient.invoke('session.list', { workspaceId })
  let sessions = (listRes?.sessions || []) as Array<{
    sessionId: string
    sessionFile?: string
    title?: string
    updatedAt?: number
  }>
  const row = {
    sessionId,
    sessionFile,
    title,
    updatedAt: Date.now(),
    messageCount: 0,
    modelId: '',
  }
  const inList = sessions.some((s) => s.sessionId === sessionId)
  if (!inList) {
    sessions = [row as SessionItem, ...sessions]
  } else {
    sessions = sessions.map((s) =>
      s.sessionId === sessionId ? { ...s, sessionFile: sessionFile ?? s.sessionFile, title } : s,
    )
  }
  store.setSessions(sessions as SessionItem[])
}