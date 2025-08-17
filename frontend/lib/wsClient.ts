// lib/wsClient.ts
export type WSMessage = {
  type: string;
  [key: string]: unknown;
};

let ws: WebSocket | null = null;
let onMsg: ((m: WSMessage) => void) | null = null;
let currentUserId: string | null = null;
let currentRole: string | null = null;

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 500; // ms (max ~5s)

// front URL -> ws(s) URL
const WS_URL = process.env.NEXT_PUBLIC_BACKEND_URL!
  .replace(/^http:/, "ws:")
  .replace(/^https:/, "wss:");

// buffer správ kým nie sme OPEN
const queue: WSMessage[] = [];

function flushQueue() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (queue.length) {
    const payload = queue.shift()!;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // swallow
    }
  }
}

function doRegister() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !currentUserId) return;
  const payload: WSMessage = { type: "register", userId: currentUserId, role: currentRole || undefined };
  ws.send(JSON.stringify(payload));
}

function setupSocket() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    // console.log("✅ WebSocket connected");
    backoff = 500;
    doRegister();
    flushQueue();
  };

  ws.onmessage = (event: MessageEvent<string>) => {
    try {
      const msg = JSON.parse(event.data) as WSMessage;
      if (onMsg) onMsg(msg);
    } catch (err) {
      // console.error("❌ WS parse error:", err);
    }
  };

  ws.onclose = () => {
    // console.warn("⚠️ WebSocket disconnected");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      setupSocket();
      backoff = Math.min(backoff * 2, 5000);
    }, backoff);
  };

  ws.onerror = () => {
    // onclose spraví reconnect
  };
}

export function connectWS(userId: string, role: string, onMessage?: (msg: WSMessage) => void) {
  currentUserId = userId;
  currentRole = role;
  onMsg = onMessage || null;

  if (!ws || ws.readyState === WebSocket.CLOSED) {
    setupSocket();
  } else if (ws.readyState === WebSocket.OPEN) {
    doRegister();
  }
}

export function sendWS(data: WSMessage) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  } else if (ws && ws.readyState === WebSocket.CONNECTING) {
    queue.push(data);
    ws.addEventListener(
      "open",
      () => {
        flushQueue();
      },
      { once: true }
    );
  } else {
    // queue + prípadný bootstrap socketu
    queue.push(data);
    if (!ws || ws.readyState === WebSocket.CLOSED) setupSocket();
  }
}
