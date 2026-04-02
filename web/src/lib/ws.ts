export interface WsMessage {
  type: string;
  data?: unknown;
  timestamp: string;
}

export interface WsClient {
  close(): void;
}

const WS_BASE =
  (process.env.NEXT_PUBLIC_API_URL || "http://localhost:9999")
    .replace("http://", "ws://")
    .replace("https://", "wss://");

export function createWsClient(
  path: string,
  onMessage: (msg: WsMessage) => void,
): WsClient {
  let ws: WebSocket | null = null;
  let closed = false;
  let retryDelay = 1000;
  const MAX_RETRY = 30000;

  function connect() {
    if (closed) return;

    ws = new WebSocket(`${WS_BASE}${path}`);

    ws.onopen = () => {
      retryDelay = 1000; // Reset on successful connection
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage;
        if (msg.type === "ping") {
          ws?.send(JSON.stringify({ type: "pong" }));
          return;
        }
        onMessage(msg);
      } catch {
        // Ignore unparseable messages
      }
    };

    ws.onclose = () => {
      if (closed) return;
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return {
    close() {
      closed = true;
      ws?.close();
    },
  };
}
