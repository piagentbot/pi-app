import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectSidebar } from './project-sidebar'
import { useUIStore } from '@renderer/stores/ui-store'

/** 模拟主进程 recentProjects 存储：拖拽写盘 + reload 读回，形成闭环 */
let storedRecent: string[] = ['/proj/A', '/proj/B', '/proj/C']
/** 置为 true 时 reorderRecent 返回失败（模拟写盘失败） */
let failReorder = false

const invokeMock = vi.fn(async (method: string, req?: { key?: string; paths?: string[] }) => {
  if (method === 'session.list') return { sessions: [] }
  if (method === 'workspace.sandbox.list') return { sandboxes: [] }
  if (method === 'settings.get' && req?.key === 'recentProjects') {
    return { settings: { recentProjects: storedRecent } }
  }
  if (method === 'settings.get' && req?.key === 'recentProjectsFixedOrder') {
    return { settings: { recentProjectsFixedOrder: true } }
  }
  if (method === 'project.reorderRecent') {
    if (failReorder) return { ok: false, error: 'disk full' }
    storedRecent = [...(req?.paths || [])]
    return { ok: true, recentProjects: storedRecent, fixedOrder: true }
  }
  if (method === 'workspace.open' || method === 'settings.set') return { ok: true }
  return {}
})

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: (method: string, req?: { key?: string; paths?: string[] }) => invokeMock(method, req) },
}))
vi.mock('@renderer/lib/refresh-workspace-session-lists', () => ({
  refreshWorkspaceSessionLists: vi.fn(async () => {}),
}))
vi.mock('@renderer/lib/activate-workspace', () => ({
  activateWorkspace: vi.fn(async () => {}),
  switchSessionInPlace: vi.fn(async () => {}),
  previewSessionInPlace: vi.fn(async () => {}),
}))
vi.mock('@renderer/features/timeline/tool-card-registry', () => ({
  useToolCardCatalogReady: () => true,
}))

const dataTransfer = () => ({ effectAllowed: '', dropEffect: '', setData: vi.fn() })

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 10))
})

describe('ProjectSidebar drag reorder', () => {
  beforeEach(() => {
    storedRecent = ['/proj/A', '/proj/B', '/proj/C']
    failReorder = false
    invokeMock.mockClear()
    useUIStore.setState({
      currentWorkspace: '/proj/A',
      recentProjects: [],
      sessions: [],
      currentSessionId: null,
      historySessionFile: null,
      timelineItems: [],
      subagentSessionGroup: null,
      sessionRuntimeRunning: {},
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('drags a project folder below another and persists the order', async () => {
    const { container } = render(<ProjectSidebar onOpenProject={() => {}} openProjectLabel="打开" />)
    await settle()

    const rows = () => [...container.querySelectorAll('.sidebar-project-row')]
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('A'),
      expect.stringContaining('B'),
      expect.stringContaining('C'),
    ])

    const [rowA, rowB] = rows()
    // jsdom 的 getBoundingClientRect 恒为 0，手动给出高度以便计算上方/下方落点
    vi.spyOn(rowB, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 40 } as DOMRect)

    await act(async () => {
      fireEvent.dragStart(rowA, { dataTransfer: dataTransfer() })
    })
    await act(async () => {
      fireEvent.dragOver(rowB, { clientY: 30, dataTransfer: dataTransfer() })
    })
    // 拖到 B 的下半区：指示线应在 B 下方
    const belowIndicator = container.querySelector('.sidebar-project-row .bg-brand')
    expect(belowIndicator).not.toBeNull()

    await act(async () => {
      fireEvent.drop(rowB, { dataTransfer: dataTransfer() })
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect(invokeMock).toHaveBeenCalledWith('project.reorderRecent', {
      paths: ['/proj/B', '/proj/A', '/proj/C'],
    })
    // reload 后按新顺序展示
    await settle()
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('B'),
      expect.stringContaining('A'),
      expect.stringContaining('C'),
    ])
  })

  it('keeps the dragged order when switching conversations/workspaces', async () => {
    const { container } = render(<ProjectSidebar onOpenProject={() => {}} openProjectLabel="打开" />)
    await settle()

    const rows = () => [...container.querySelectorAll('.sidebar-project-row')]
    const [rowA, rowB] = rows()
    vi.spyOn(rowB, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 40 } as DOMRect)

    await act(async () => {
      fireEvent.dragStart(rowA, { dataTransfer: dataTransfer() })
    })
    await act(async () => {
      fireEvent.dragOver(rowB, { clientY: 30, dataTransfer: dataTransfer() })
    })
    await act(async () => {
      fireEvent.drop(rowB, { dataTransfer: dataTransfer() })
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    await settle()
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('B'),
      expect.stringContaining('A'),
      expect.stringContaining('C'),
    ])

    // 切到 B 后固定顺序不变：B 不能跳到顶部，A 也不能被顶置
    await act(async () => {
      useUIStore.getState().setWorkspace('/proj/B')
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('B'),
      expect.stringContaining('A'),
      expect.stringContaining('C'),
    ])
  })

  it('reverts to the previous order and keeps it stable when persisting fails', async () => {
    failReorder = true

    const { container } = render(<ProjectSidebar onOpenProject={() => {}} openProjectLabel="打开" />)
    await settle()

    const rows = () => [...container.querySelectorAll('.sidebar-project-row')]
    const [rowA, rowB] = rows()
    vi.spyOn(rowB, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 40 } as DOMRect)

    await act(async () => {
      fireEvent.dragStart(rowA, { dataTransfer: dataTransfer() })
    })
    await act(async () => {
      fireEvent.dragOver(rowB, { clientY: 30, dataTransfer: dataTransfer() })
    })
    await act(async () => {
      fireEvent.drop(rowB, { dataTransfer: dataTransfer() })
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    // 写盘失败：回滚到拖拽前的顺序
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('A'),
      expect.stringContaining('B'),
      expect.stringContaining('C'),
    ])
  })
})
