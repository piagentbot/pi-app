/** 项目 MRU 列表上限（与 config-store 历史行为一致）。 */
export const RECENT_PROJECTS_CAP = 10

/**
 * 计算 addRecentProject 之后的新列表。
 * fixedOrder=true：顺序固定，已有项目保持不变，新项目追加到末尾（超出上限时丢弃最旧的）；
 * fixedOrder=false（默认）：最近使用优先，项目移到最前（超出上限时丢弃最旧的）。
 */
export function nextRecentProjects(recent: string[], path: string, fixedOrder: boolean): string[] {
  if (fixedOrder) {
    if (recent.includes(path)) return recent
    return [...recent, path].slice(-RECENT_PROJECTS_CAP)
  }
  const next = recent.filter((p) => p !== path)
  next.unshift(path)
  return next.slice(0, RECENT_PROJECTS_CAP)
}

/**
 * 顺序模式一次性迁移判定：旧版本默认 MRU（recentProjectsFixedOrder=false），
 * 新版本默认固定顺序（切换对话/打开项目不改已有排序）。
 * 仅在「显式存着 false 且从未迁移过」时迁移，用户之后仍可在设置里自由切换。
 */
export function shouldMigrateFixedOrder(
  current: boolean | undefined,
  migrated: boolean | undefined,
): boolean {
  return current === false && !migrated
}
