/**
 * Repro: 打开一个正在工作的 session 时，当前正在流式的对话被吞掉。
 *
 * 场景（冷打开，无 shell 缓存）：
 * 1. Session A 在后台 worker 里正在跑（多会话），渲染层通过 background 事件维护 live cache，
 *    live cache 里只有「当前 turn」的流式尾：[U3(e3), A3(streaming)]。
 * 2. 用户在列表里点开 A。focusSessionSync 无缓存视图 → empty + hydrate。
 * 3. hydrate 的磁盘读（ipc:session.getMessages）返回的是过期的 JSONL 尾部：
 *    - 磁盘上还没有 U3/A3（turn 未落盘），只有 [U1(e1), A1, U2(e2), A2]。
 * 4. 合并（mergeLiveTimelineWithHistoryTail）若直接回到「磁盘权威」分支，
 *    当前 turn 的 U3/A3 就从可见时间线里消失 → 对话被吞掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const historyMock = vi.hoisted(() => ({
  fetch: vi.fn(),
}))

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn().mockResolvedValue({}) },
}))
vi.mock('@renderer/lib/session-history', () => ({
  fetchSessionHistoryTail: historyMock.fetch,
}))
vi.mock('@renderer/lib/session-display-meta', () => ({
  applyComposerDisplayMeta: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@renderer/lib/session-worker-sync', () => ({
  fetchWorkerLiveSnapshot: vi.fn().mockResolvedValue({
    sessionId: null,
    sessionFile: null,
    status: 'idle',
  }),
}))

import {
  clearSessionShellForTests,
  focusSessionSync,
  hydrateSessionView,
} from '@renderer/lib/session-shell'
import { clearLiveSessionTimeline, saveLiveSessionTimeline } from '@renderer/lib/live-session-timeline-cache'
import { clearSessionTimelineView } from '@renderer/lib/session-timeline-views'
import { clearStreamPending } from '@renderer/stores/ui-store-stream'
import { useUIStore } from '@renderer/stores/ui-store'

const sessionA = '/tmp/running-a.jsonl'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Disk tail 里只有旧轮次，当前 turn (U3/A3) 尚未落盘。 */
const staleDiskItems = [
  { id: 'u1', type: 'user-message', text: 'q1', sessionEntryId: 'e1', turnId: 'turn-1', timestamp: 1 },
  { id: 'a1', type: 'assistant-message', text: 'a1', sessionEntryId: 'e1', turnId: 'turn-1', timestamp: 2 },
  { id: 'u2', type: 'user-message', text: 'q2', sessionEntryId: 'e2', turnId: 'turn-2', timestamp: 3 },
  { id: 'a2', type: 'assistant-message', text: 'a2', sessionEntryId: 'e2', turnId: 'turn-2', timestamp: 4 },
]

describe('open a running session — conversation swallow repro', () => {
  beforeEach(() => {
    historyMock.fetch.mockReset()
    clearStreamPending()
    clearLiveSessionTimeline()
    clearSessionTimelineView()
    clearSessionShellForTests()
    useUIStore.setState({
      currentWorkspace: '/workspace',
      currentSessionId: 'session-b',
      historySessionFile: '/tmp/other-b.jsonl',
      historyTotalCount: 0,
      historyLoadedCount: 0,
      historyLoading: false,
      timelineItems: [],
      streamingAssistantId: null,
      optimisticPendingUserText: null,
      agentTurnBootstrapping: false,
      pendingSteering: [],
      pendingFollowUp: [],
      sessionRuntimeRunning: {},
      runState: { status: 'idle', toolCount: 0, errorCount: 0 },
      workerLiveSnapshot: { sessionId: null, sessionFile: null, status: 'idle' },
      fileChanges: [],
      ignoreQueueSyncUntil: 0,
    })
  })

  it('cold open must NOT lose the current turn when disk lags behind the live stream', async () => {
    // Background live cache: 只有当前 turn 的流式尾（U3 已收到 end → 有 sessionEntryId，A3 还在流）。
    saveLiveSessionTimeline({
      sessionId: 'session-a',
      sessionFile: sessionA,
      timelineItems: [
        { id: 'live-u3', type: 'user-message', text: 'q3', sessionEntryId: 'e3', turnId: 'turn-3', runId: 'run-3', timestamp: 5 },
        { id: 'live-a3', type: 'assistant-message', text: 'streaming answer…', runId: 'run-3', turnId: 'turn-3', timestamp: 6 },
      ],
      streamingAssistantId: 'live-a3',
      runState: { status: 'running', activeRunId: 'run-3', toolCount: 0, errorCount: 0 },
      pendingSteering: [],
      pendingFollowUp: [],
      optimisticPendingUserText: null,
      agentTurnBootstrapping: false,
    })

    // 用户点开 A（无 shell 缓存 → 冷打开）
    focusSessionSync('session-a', sessionA)

    const history = deferred<{
      items: Array<Record<string, unknown>>
      sourceCount: number
      totalCount: number
    }>()
    historyMock.fetch.mockReturnValueOnce(history.promise)
    const hydration = hydrateSessionView(sessionA, 'session-a')

    // 磁盘快照过期：当前 turn 未落盘
    history.resolve({
      items: staleDiskItems,
      sourceCount: 4,
      totalCount: 4,
    })
    await hydration

    const items = useUIStore.getState().timelineItems
    const texts = items.map((i) => [i.type, i.text])
    // 当前 turn（q3 / streaming answer…）绝不能丢
    expect(texts.some(([t, x]) => t === 'user-message' && x === 'q3')).toBe(true)
    expect(texts.some(([t, x]) => t === 'assistant-message' && String(x).includes('streaming answer'))).toBe(true)
  })

  it('cold open keeps streaming tail when disk has user msg but not assistant', async () => {
    // 磁盘有 U3，但没有 A3（助手消息只有结束才落盘）
    const diskWithUser = [
      ...staleDiskItems,
      { id: 'u3', type: 'user-message', text: 'q3', sessionEntryId: 'e3', turnId: 'turn-3', runId: 'run-3', timestamp: 5 },
    ]
    saveLiveSessionTimeline({
      sessionId: 'session-a',
      sessionFile: sessionA,
      timelineItems: [
        { id: 'live-u3', type: 'user-message', text: 'q3', sessionEntryId: 'e3', turnId: 'turn-3', runId: 'run-3', timestamp: 5 },
        { id: 'live-a3', type: 'assistant-message', text: 'streaming answer…', runId: 'run-3', turnId: 'turn-3', timestamp: 6 },
      ],
      streamingAssistantId: 'live-a3',
      runState: { status: 'running', activeRunId: 'run-3', toolCount: 0, errorCount: 0 },
      pendingSteering: [],
      pendingFollowUp: [],
      optimisticPendingUserText: null,
      agentTurnBootstrapping: false,
    })

    focusSessionSync('session-a', sessionA)
    const history = deferred<{
      items: Array<Record<string, unknown>>
      sourceCount: number
      totalCount: number
    }>()
    historyMock.fetch.mockReturnValueOnce(history.promise)
    const hydration = hydrateSessionView(sessionA, 'session-a')

    history.resolve({ items: diskWithUser, sourceCount: 5, totalCount: 5 })
    await hydration

    const items = useUIStore.getState().timelineItems
    const texts = items.map((i) => [i.type, i.text])
    expect(texts.some(([t, x]) => t === 'assistant-message' && String(x).includes('streaming answer'))).toBe(true)
    expect(items.at(-1)?.id).not.toBe('a2')
  })

  it('cold open keeps assistant-only live tail (renderer reloaded mid-turn)', async () => {
    // 渲染层重载后：live cache 只剩 assistant-only 流式尾（用户消息事件已错过）
    saveLiveSessionTimeline({
      sessionId: 'session-a',
      sessionFile: sessionA,
      timelineItems: [
        { id: 'live-a3', type: 'assistant-message', text: 'recovered streaming answer…', runId: 'run-3', turnId: 'turn-3', timestamp: 6 },
      ],
      streamingAssistantId: 'live-a3',
      runState: { status: 'running', activeRunId: 'run-3', toolCount: 0, errorCount: 0 },
      pendingSteering: [],
      pendingFollowUp: [],
      optimisticPendingUserText: null,
      agentTurnBootstrapping: false,
    })

    focusSessionSync('session-a', sessionA)
    const history = deferred<{
      items: Array<Record<string, unknown>>
      sourceCount: number
      totalCount: number
    }>()
    historyMock.fetch.mockReturnValueOnce(history.promise)
    const hydration = hydrateSessionView(sessionA, 'session-a')

    history.resolve({ items: staleDiskItems, sourceCount: 4, totalCount: 4 })
    await hydration

    const items = useUIStore.getState().timelineItems
    const texts = items.map((i) => [i.type, i.text])
    expect(
      texts.some(([t, x]) => t === 'assistant-message' && String(x).includes('recovered streaming answer')),
    ).toBe(true)
  })
})
