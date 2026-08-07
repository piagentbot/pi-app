import { describe, expect, it } from 'vitest'
import { nextRecentProjects, RECENT_PROJECTS_CAP, shouldMigrateFixedOrder } from './recent-projects'

describe('nextRecentProjects', () => {
  describe('MRU mode (default, fixedOrder=false)', () => {
    it('moves an existing project to the front', () => {
      expect(nextRecentProjects(['a', 'b', 'c'], 'b', false)).toEqual(['b', 'a', 'c'])
    })

    it('puts a new project at the front', () => {
      expect(nextRecentProjects(['a', 'b'], 'c', false)).toEqual(['c', 'a', 'b'])
    })

    it('caps at the most recent 10', () => {
      const full = Array.from({ length: RECENT_PROJECTS_CAP }, (_, i) => `p${i}`)
      const next = nextRecentProjects(full, 'new', false)
      expect(next).toHaveLength(RECENT_PROJECTS_CAP)
      expect(next[0]).toBe('new')
      expect(next).not.toContain('p9')
    })
  })

  describe('fixed order (fixedOrder=true)', () => {
    it('keeps existing projects in place', () => {
      expect(nextRecentProjects(['a', 'b', 'c'], 'b', true)).toEqual(['a', 'b', 'c'])
      expect(nextRecentProjects(['a', 'b', 'c'], 'c', true)).toEqual(['a', 'b', 'c'])
    })

    it('appends a new project at the end', () => {
      expect(nextRecentProjects(['a', 'b'], 'c', true)).toEqual(['a', 'b', 'c'])
    })

    it('caps by dropping the oldest (first) entry', () => {
      const full = Array.from({ length: RECENT_PROJECTS_CAP }, (_, i) => `p${i}`)
      const next = nextRecentProjects(full, 'new', true)
      expect(next).toHaveLength(RECENT_PROJECTS_CAP)
      expect(next[next.length - 1]).toBe('new')
      expect(next).not.toContain('p0')
    })
  })
})

describe('shouldMigrateFixedOrder', () => {
  it('migrates explicit MRU configs that have never been migrated', () => {
    expect(shouldMigrateFixedOrder(false, false)).toBe(true)
  })

  it('does not migrate already-fixed or already-migrated configs', () => {
    expect(shouldMigrateFixedOrder(true, false)).toBe(false)
    expect(shouldMigrateFixedOrder(false, true)).toBe(false)
    expect(shouldMigrateFixedOrder(true, true)).toBe(false)
  })

  it('does not migrate configs where the key was never written (new default is fixed)', () => {
    expect(shouldMigrateFixedOrder(undefined, undefined)).toBe(false)
  })
})
