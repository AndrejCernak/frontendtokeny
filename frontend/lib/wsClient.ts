// lib/wsClient.ts
export type WSMessage = {
  type: string;
  [key: string]: unknown;
};

// ——— jedinečný identifikátor pre KAŽDÝ TAB/ZARIADENIE ———
function genId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    // @ts-ignore
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
export const DEVICE_ID = (() => {
  try {
    const k = "ws-device-id";
    const existing = typeof window !== "undefined" ? localStorage.getItem(k) : null;
    // každý TAB musí mať vlastné ID → nepoužijeme localStorage zdieľane,
    // lebo by spôsobil kolízie medzi tabmi; ponecháme per-tab ID:
    return genId();
  } catch {
    return genId();
  }
})();

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

function withMeta(data: WSMessage): WSMessage {
  // Pripni deviceId ku každej správe (kritické pri multi-device)
  return { deviceId: DEVICE_ID, ...data };
}

function flushQueue() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (queue.length) {
    const payload = queue.shift()!;
    try {
      ws.send(JSON.stringify(withMeta(payload)));
    } catch {
      // swallow
    }
  }
}

function doRegister() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !currentUserId) return;
  const payload: WSMessage = {
    type: "register",
    userId: currentUserId,
    role: currentRole || undefined,
    deviceId: DEVICE_ID, // <<< dôležité
  };
  ws.send(JSON.stringify(payload));
}

function setupSocket() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    backoff = 500;
    doRegister();
    flushQueue();
  };

  ws.onmessage = (event: MessageEvent<string>) => {
    try {
      const msg = JSON.parse(event.data) as WSMessage;

      // Ak príde správa s targetDeviceId a nie je pre tento TAB, ignoruj ju.
      const tDev = (msg as any).targetDeviceId as string | undefined;
      if (tDev && tDev !== DEVICE_ID) return;

      if (onMsg) onMsg(msg);
    } catch {
      // parse error – ignoruj
    }
  };

  ws.onclose = () => {
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

export function connectWS(
  userId: string,
  role: string,
  onMessage?: (msg: WSMessage) => void
) {
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
  const payload = withMeta(data);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  } else if (ws && ws.readyState === WebSocket.CONNECTING) {
    queue.push(payload);
    ws.addEventListener("open", () => {
      flushQueue();
    }, { once: true });
  } else {
    queue.push(payload);
    if (!ws || ws.readyState === WebSocket.CLOSED) setupSocket();
  }
}
