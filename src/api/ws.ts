import type { WsMessage, WsMessageType } from "./types.ts";

export interface WsData {
  channel: string;
  sessionId?: string;
}

export class NanoClawEvents {
  private channels = new Map<string, Set<{ send: (msg: string) => void }>>();

  emit(channel: string, event: WsMessage): void {
    const subscribers = this.channels.get(channel);
    if (!subscribers || subscribers.size === 0) return;
    const msg = JSON.stringify(event);
    for (const ws of subscribers) {
      try {
        ws.send(msg);
      } catch {
        // Connection may have closed between check and send
      }
    }
  }

  subscribe(channel: string, ws: { send: (msg: string) => void }): void {
    let subs = this.channels.get(channel);
    if (!subs) {
      subs = new Set();
      this.channels.set(channel, subs);
    }
    subs.add(ws);
  }

  unsubscribe(channel: string, ws: { send: (msg: string) => void }): void {
    const subs = this.channels.get(channel);
    if (!subs) return;
    subs.delete(ws);
    if (subs.size === 0) this.channels.delete(channel);
  }

  unsubscribeAll(ws: { send: (msg: string) => void }): void {
    for (const [channel, subs] of this.channels) {
      subs.delete(ws);
      if (subs.size === 0) this.channels.delete(channel);
    }
  }

  getSubscriberCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }

  getChannelCount(): number {
    return this.channels.size;
  }
}

/** Parse WebSocket URL path to determine channel and session ID. */
export function parseWsPath(
  pathname: string,
): { channel: string; sessionId?: string } | null {
  // /api/ws/sessions/:id/stream
  const sessionMatch = pathname.match(
    /^\/api\/ws\/sessions\/([^/]+)\/stream$/,
  );
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    return { channel: `session:${sessionId}`, sessionId };
  }

  // /api/ws/notifications
  if (pathname === "/api/ws/notifications") {
    return { channel: "notifications" };
  }

  return null;
}

/** Create a WsMessage with current timestamp. */
export function createWsMessage(
  type: WsMessageType,
  data?: unknown,
): WsMessage {
  return { type, timestamp: new Date().toISOString(), data };
}
