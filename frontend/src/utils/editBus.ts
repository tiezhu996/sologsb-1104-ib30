import type { LeaseChannelMessage } from '../types/lease'

type BusListener = (message: LeaseChannelMessage) => void

/**
 * 跨标签页编辑事件总线。BroadcastChannel 不会把消息回送给发送者自身，
 * 因此各标签页收到的一定是“别的页”发出的租约/暂存变更。
 */
class EditEventBus {
  private channel: BroadcastChannel | null

  constructor() {
    this.channel = typeof BroadcastChannel === 'undefined'
      ? null
      : new BroadcastChannel('gbmortise-edits')
  }

  post(message: LeaseChannelMessage): void {
    try {
      this.channel?.postMessage(message)
    } catch {
      // 通道不可用时退化为仅本页状态，租约判定仍以 IndexedDB 为准
    }
  }

  subscribe(listener: BusListener): () => void {
    if (!this.channel) return () => {}
    const handler = (event: MessageEvent<LeaseChannelMessage>) => listener(event.data)
    this.channel.addEventListener('message', handler)
    return () => this.channel?.removeEventListener('message', handler)
  }
}

export const editBus = new EditEventBus()
