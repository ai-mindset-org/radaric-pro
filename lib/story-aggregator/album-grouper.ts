export interface TelegramMessage {
  messageId: number
  groupedId: string | null
  text: string | null
  mediaUrl: string | null
  /** A video/audio poster; equals `mediaUrl` for photos (RAD-359). */
  thumbUrl?: string | null
  date: number
  telegramPostUrl: string | null
}

export interface GroupedMessage {
  messageIds: number[]
  primaryMessageId: number
  text: string | null
  mediaUrls: string[]
  /** A real cover — first image URL or a video poster; never a video URL itself. */
  thumbnailUrl?: string | null
  groupedId: string | null
  date: number
  telegramPostUrl: string | null
}

interface PendingGroup {
  messages: TelegramMessage[]
  resolvers: Array<(result: GroupedMessage | null) => void>
  timerId: ReturnType<typeof setTimeout>
}

export class AlbumGrouper {
  private readonly debounceMs: number
  private readonly pending: Map<string, PendingGroup> = new Map()

  constructor(debounceMs = 10000) {
    this.debounceMs = debounceMs
  }

  get pendingCount(): number {
    return this.pending.size
  }

  add(message: TelegramMessage): Promise<GroupedMessage | null> {
    // Non-grouped messages bypass debounce and resolve immediately
    if (message.groupedId === null) {
      return Promise.resolve(this.buildGroupedMessage([message], null))
    }

    const gid = message.groupedId

    return new Promise<GroupedMessage | null>((resolve) => {
      if (this.pending.has(gid)) {
        const group = this.pending.get(gid)!
        // Reset the debounce timer
        clearTimeout(group.timerId)
        group.messages.push(message)
        group.resolvers.push(resolve)
        group.timerId = setTimeout(() => this.flush(gid), this.debounceMs)
      } else {
        const timerId = setTimeout(() => this.flush(gid), this.debounceMs)
        this.pending.set(gid, {
          messages: [message],
          resolvers: [resolve],
          timerId,
        })
      }
    })
  }

  flushAll(): GroupedMessage[] {
    const results: GroupedMessage[] = []
    for (const gid of Array.from(this.pending.keys())) {
      results.push(this.flush(gid))
    }
    return results
  }

  private flush(gid: string): GroupedMessage {
    const group = this.pending.get(gid)
    if (!group) {
      // Already flushed — return empty sentinel (should not happen in normal use)
      return this.buildGroupedMessage([], gid)
    }

    clearTimeout(group.timerId)
    this.pending.delete(gid)

    const result = this.buildGroupedMessage(group.messages, gid)
    // Only the first resolver gets the merged result.
    // Others receive null — the album is already handled by the first caller.
    group.resolvers[0]?.(result)
    for (let i = 1; i < group.resolvers.length; i++) {
      group.resolvers[i](null)
    }
    return result
  }

  private buildGroupedMessage(
    messages: TelegramMessage[],
    groupedId: string | null,
  ): GroupedMessage {
    const sorted = [...messages].sort((a, b) => a.messageId - b.messageId)
    const messageIds = sorted.map((m) => m.messageId)
    const primaryMessageId = sorted.length > 0 ? sorted[0].messageId : 0
    const date = sorted.length > 0 ? sorted[0].date : 0
    const text = sorted.find((m) => m.text !== null)?.text ?? null
    const mediaUrls = sorted
      .map((m) => m.mediaUrl)
      .filter((url): url is string => url !== null)
    // A cover an <img> can paint: a photo (its thumb is the URL itself), else
    // the first video/audio poster; never a playable URL (RAD-359).
    const photo = sorted.find((m) => m.mediaUrl !== null && m.thumbUrl === m.mediaUrl)
    const thumbnailUrl =
      photo?.mediaUrl ?? sorted.find((m) => m.thumbUrl != null)?.thumbUrl ?? null
    const telegramPostUrl =
      sorted.find((m) => m.telegramPostUrl !== null)?.telegramPostUrl ?? null

    return { messageIds, primaryMessageId, text, mediaUrls, thumbnailUrl, groupedId, date, telegramPostUrl }
  }
}
