import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFilesPanel } from './workspace-files-panel'
import { useUIStore } from '@renderer/stores/ui-store'

const invokeMock = vi.hoisted(() =>
  vi.fn(async (method: string, req?: Record<string, unknown>): Promise<unknown> => undefined),
)

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: (method: string, req?: Record<string, unknown>) => invokeMock(method, req) },
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const zh: Record<string, string> = {
        'menu.rename': '重命名',
        'menu.preview': '预览',
        'menu.attach': '添加到聊天',
        'menu.copyPath': '复制路径',
        'menu.reveal': '在文件夹中显示',
        'menu.openInNewTab': '在新窗口打开',
        'rename.title': '重命名',
        'rename.confirm': '确定',
        'rename.cancel': '取消',
        'toast.renamed': '已重命名',
        'toast.renameFailed': '重命名失败',
        'preview.loading': '加载预览…',
        'preview.pickFile': '在右侧选择文件以预览',
        'preview.deleted': '文件已删除或已移走',
        'search.placeholder': '搜索当前目录…',
        'chrome.noFile': '未选择文件',
        'tabs.close': '关闭标签',
        'tree.loadMore': '再显示更多…',
      }
      const v = values && Object.keys(values).length ? JSON.stringify(values) : ''
      return (zh[key] ?? key) + v
    },
  }),
}))

vi.mock('sonner', () => ({
  toast: { message: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

const listDirCalls: string[] = []
const readTextCalls: string[] = []
let diskFiles: { name: string; path: string }[] = []

function mockWorkspaceFs() {
  diskFiles = [{ name: 'foo.txt', path: 'foo.txt' }]
  invokeMock.mockImplementation(async (method: string, req?: Record<string, unknown>) => {
    switch (method) {
      case 'workspace.fs.listDir': {
        listDirCalls.push(String(req?.path))
        const entries = diskFiles.map((f) => ({ ...f, isDirectory: false, size: 5, mtimeMs: 1 }))
        return { ok: true, entries: req?.path === '.' ? entries : [], truncated: false, totalCount: 0 }
      }
      case 'workspace.fs.readText': {
        const p = String(req?.path)
        readTextCalls.push(p)
        if (p === 'foo.txt') return { ok: true, content: 'OLD CONTENT', size: 11 }
        if (p === 'bar.txt') return { ok: true, content: 'NEW CONTENT', size: 11 }
        return { ok: false, error: 'not_found' }
      }
      case 'workspace.fs.rename': {
        const oldRel = String(req?.relativePath)
        const newRel = String(req?.newName)
        diskFiles = diskFiles.map((f) => (f.path === oldRel ? { name: newRel, path: newRel } : f))
        return { ok: true, newRelativePath: newRel }
      }
      default:
        return {}
    }
  })
}

function treeRow(name: string): HTMLElement {
  const rail = document.querySelector('.files-explorer-rail') as HTMLElement
  return within(rail).getByText(name).closest('.files-tree-row') as HTMLElement
}

beforeEach(() => {
  listDirCalls.length = 0
  readTextCalls.length = 0
  mockWorkspaceFs()
  useUIStore.setState({
    currentWorkspace: '/tmp/proj',
    activePanel: 'files',
    rightPanelCollapsed: false,
    filesPreviewChatExpand: false,
  } as never)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('file rename refreshes open tab', () => {
  it('renaming an open file refreshes the tab label, preview and tree immediately', async () => {
    render(<WorkspaceFilesPanel />)

    // 1. Tree loads, click foo.txt row to open a preview tab
    await waitFor(() => expect(treeRow('foo.txt')).toBeTruthy())
    fireEvent.click(treeRow('foo.txt'))

    // 2. Preview shows old content
    await waitFor(() => expect(screen.getByText('OLD CONTENT')).toBeTruthy())
    expect(readTextCalls).toContain('foo.txt')

    // 3. Right-click foo.txt tree row -> context menu -> rename
    fireEvent.contextMenu(treeRow('foo.txt'))
    const renameBtn = await screen.findByText('重命名')
    fireEvent.click(renameBtn)

    // 4. Dialog opens; type new name and confirm
    const input = await screen.findByRole('textbox')
    await act(async () => {
      await userEvent.clear(input)
      await userEvent.type(input, 'bar.txt')
    })
    fireEvent.click(screen.getByText('确定'))

    // 5. Tab label should now be bar.txt
    await waitFor(() => {
      const tab = screen.getByRole('tab', { name: /bar\.txt/ })
      expect(tab).toBeTruthy()
    })

    // 6. Preview should reload the renamed file immediately (no 2s idle wait)
    await waitFor(() => expect(screen.getByText('NEW CONTENT')).toBeTruthy())
    expect(readTextCalls).toContain('bar.txt')

    // 7. Tree row should show the new name
    await waitFor(() => expect(treeRow('bar.txt')).toBeTruthy())
  })
})

describe('directory rename follows open tabs', () => {
  it('renaming a folder refreshes open tabs of files inside it', async () => {
    // workspace: dir/foo.txt
    diskFiles = [
      { name: 'dir', path: 'dir' },
      { name: 'foo.txt', path: 'dir/foo.txt' },
    ]
    invokeMock.mockImplementation(async (method: string, req?: Record<string, unknown>) => {
      const p = String(req?.path ?? '')
      switch (method) {
        case 'workspace.fs.listDir': {
          if (p === '.') {
            return {
              ok: true,
              entries: diskFiles
                .filter((f) => !f.path.includes('/'))
                .map((f) => ({ ...f, isDirectory: f.name === 'dir', size: 0, mtimeMs: 1 })),
              truncated: false,
              totalCount: 0,
            }
          }
          if (p === 'dir') {
            return {
              ok: true,
              entries: diskFiles
                .filter((f) => f.path.startsWith('dir/'))
                .map((f) => ({ ...f, isDirectory: false, size: 5, mtimeMs: 1 })),
              truncated: false,
              totalCount: 0,
            }
          }
          return { ok: true, entries: [], truncated: false, totalCount: 0 }
        }
        case 'workspace.fs.readText': {
          readTextCalls.push(p)
          if (p === 'dir/foo.txt') return { ok: true, content: 'OLD CONTENT', size: 11 }
          if (p === 'dir2/foo.txt') return { ok: true, content: 'NEW CONTENT', size: 11 }
          return { ok: false, error: 'not_found' }
        }
        case 'workspace.fs.rename': {
          const oldRel = String(req?.relativePath)
          const newName = String(req?.newName)
          // rename dir -> dir2, moving children
          diskFiles = diskFiles.map((f) =>
            f.path === oldRel
              ? { name: newName, path: newName }
              : f.path.startsWith(`${oldRel}/`)
                ? { ...f, name: f.name, path: `${newName}/${f.path.slice(oldRel.length + 1)}` }
                : f,
          )
          return { ok: true, newRelativePath: newName }
        }
        default:
          return {}
      }
    })

    render(<WorkspaceFilesPanel />)

    // 1. expand dir, open dir/foo.txt as a tab
    await waitFor(() => expect(treeRow('dir')).toBeTruthy())
    fireEvent.click(treeRow('dir'))
    await waitFor(() => expect(treeRow('foo.txt')).toBeTruthy())
    fireEvent.click(treeRow('foo.txt'))
    await waitFor(() => expect(screen.getByText('OLD CONTENT')).toBeTruthy())

    // 2. rename dir -> dir2 via context menu on the dir row
    fireEvent.contextMenu(treeRow('dir'))
    const renameBtn = await screen.findByText('重命名')
    fireEvent.click(renameBtn)
    const input = await screen.findByRole('textbox')
    await act(async () => {
      await userEvent.clear(input)
      await userEvent.type(input, 'dir2')
    })
    fireEvent.click(screen.getByText('确定'))

    // 3. the open tab should follow the file to dir2/foo.txt and show NEW CONTENT
    await waitFor(
      () => expect(screen.getByText('NEW CONTENT')).toBeTruthy(),
      { timeout: 3000 },
    )
    expect(readTextCalls).toContain('dir2/foo.txt')
  })
})
