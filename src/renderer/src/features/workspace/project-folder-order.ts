/** 侧栏项目文件夹的显示顺序。 */
export function projectFolderOrder(
  recentProjects: string[],
  currentWorkspace: string | null | undefined,
  fixedOrder: boolean,
): string[] {
  const out: string[] = []
  const add = (p: string) => {
    if (p && !out.includes(p)) out.push(p)
  }
  if (fixedOrder) {
    // 固定顺序：完全按存储顺序展示，当前项目不置顶，仅保证在列表中
    for (const p of recentProjects) add(p)
    if (currentWorkspace) add(currentWorkspace)
  } else {
    // 最近使用（默认）：当前项目置顶，其余按 MRU
    if (currentWorkspace) add(currentWorkspace)
    for (const p of recentProjects) add(p)
  }
  return out
}

export type DropPosition = 'above' | 'below'

/**
 * 拖拽排序：把 fromPath 移动到 targetPath 的上方/下方，返回新列表。
 * 任一路径不在列表中原样返回（调用方据此跳过写盘）。
 */
export function applyProjectReorder(
  list: string[],
  fromPath: string,
  targetPath: string,
  position: DropPosition,
): string[] {
  const fromIdx = list.indexOf(fromPath)
  const targetIdx = list.indexOf(targetPath)
  if (fromIdx < 0 || targetIdx < 0) return list
  const out = list.filter((p) => p !== fromPath)
  let insertIdx = out.indexOf(targetPath)
  if (position === 'below') insertIdx += 1
  out.splice(insertIdx, 0, fromPath)
  return out
}
