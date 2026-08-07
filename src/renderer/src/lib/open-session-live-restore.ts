import type { TimelineItem } from '@renderer/stores/ui-store-types'
import type { LiveSessionTimelineSnapshot } from '@renderer/lib/live-session-timeline-cache'
import { mergeLiveTimelineWithHistoryTail } from '@renderer/lib/merge-live-history-timeline'
import { liveSnapshotActive } from '@renderer/lib/live-session-timeline-cache'
import {
  applyLiveStreamingTextToMergedTimeline,
  resolveMergedStreamingAssistantId,
} from '@renderer/lib/streaming-timeline-preserve'
import { projectTimelineItems } from '@shared/timeline-projection'
import type { TimelineSyncCursor } from '@shared/session-timeline-sync-plan'

export function mergeLiveActiveSessionDisplay(input: {
  diskItems: TimelineItem[]
  live: LiveSessionTimelineSnapshot
  totalCount: number
  cursor: TimelineSyncCursor
}): {
  displayed: TimelineItem[]
  mergedStreamId: string | null
  historyLoadedCount: number
  totalCount: number
} {
  const merged = applyLiveStreamingTextToMergedTimeline(
    mergeLiveTimelineWithHistoryTail(
      input.diskItems,
      input.live.timelineItems,
      input.live.persistedEntryOverlap,
      { liveActive: liveSnapshotActive(input.live) },
    ),
    input.live.timelineItems,
    input.live.streamingAssistantId,
  )
  const displayed = projectTimelineItems(merged)
  const mergedStreamId = resolveMergedStreamingAssistantId(
    displayed,
    input.live.timelineItems,
    input.live.streamingAssistantId,
  )
  const totalCount = Math.max(input.totalCount, input.cursor.totalCount)
  const historyLoadedCount = Math.min(totalCount, input.cursor.loadedOffsetFromEnd)
  return { displayed, mergedStreamId, historyLoadedCount, totalCount }
}