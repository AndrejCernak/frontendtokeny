// lib/wsClient.ts
export type WSMessage = {
  type: string;
  [key: string]: unknown;
};

let ws: WebSocket | null = null;
let onMsg: ((m: WSMessage) => void) | null = null;
let currentUserId: string | null = null;
let currentRole: string | null = null;

let queue: any[] = [];
let reconnectTimer: any = null;
let backoff = 500; // ms (max ~5s)

const WS_URL = process.env.NEXT_PUBLIC_BACKEND_URL!
  .replace(/^http:/, "ws:")
  .replace(/^https:/, "wss:");

function flushQueue() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (queue.length) {
    const p = queue.shift();
    try {
      ws.send(JSON.stringify(p));
    } catch (_) {}
  }
}

function doRegister() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !currentUserId) return;
  const payload = { type: "register", userId: currentUserId, role: currentRole || undefined };
  ws.send(JSON.stringify(payload));
}

function setupSocket() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("✅ WebSocket connected");
    backoff = 500;
    doRegister();
    flushQueue();
  };

  ws.onmessage = (event) => {
    try {
      const msg: WSMessage = JSON.parse(event.data);
      // nič nefiltrujeme => callId prejde
      onMsg && onMsg(msg);
    } catch (err) {
      console.error("❌ WS parse error:", err);
    }
  };

  ws.onclose = () => {
    console.warn("⚠️ WebSocket disconnected");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      setupSocket();
      backoff = Math.min(backoff * 2, 5000);
    }, backoff);
  };

  ws.onerror = (err) => {
    console.error("❌ WebSocket error:", err);
    // onclose urobí reconnect
  };
}

export const connectWS = (
  userId: string,
  role: string,
  onMessage?: (msg: WSMessage) => void
) => {
  currentUserId = userId;
  currentRole = role;
  onMsg = onMessage || null;

  if (!ws || ws.readyState === WebSocket.CLOSED) {
    setupSocket();
  } else if (ws.readyState === WebSocket.OPEN) {
    doRegister();
  } else {
    // CONNECTING – zaregistrujeme po open
  }
};

export const sendWS = (data: any) => {
  // payload ponechávame tak, ako je (vrátane callId)
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
    console.warn("⏳ WS not connected, queueing payload");
    queue.push(data);
    // skúsime sa reconnectnúť ak socket nie je
    if (!ws || ws.readyState === WebSocket.CLOSED) setupSocket();
  }
};
