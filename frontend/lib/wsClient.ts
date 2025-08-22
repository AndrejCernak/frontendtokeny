// /lib/wsClient.ts
let WS: WebSocket | null = null;
export const DEVICE_ID =
  (typeof window !== "undefined" && (localStorage.getItem("device-id") || (() => {
    const id = crypto.randomUUID();
    localStorage.setItem("device-id", id);
    return id;
  })())) || "unknown-device";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001";

type Msg = Record<string, unknown>;
type Handler = (msg: Msg) => void;

export function connectWS(userId: string, role: string, onMessage: Handler) {
  if (WS && WS.readyState === WebSocket.OPEN) return;

  WS = new WebSocket(WS_URL);
  WS.onopen = () => {
    // 🚨 DÔLEŽITÉ: REGISTER hneď po pripojení
    WS?.send(JSON.stringify({ type: "register", userId, deviceId: DEVICE_ID }));
  };
  WS.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      onMessage(data);
    } catch {}
  };
  WS.onclose = () => {
    WS = null;
  };
  WS.onerror = () => {};
}

export function sendWS(payload: Msg) {
  if (!WS || WS.readyState !== WebSocket.OPEN) {
    console.warn("WS not ready, dropping message", payload);
    return;
  }
  // doplň deviceId do každej správy
  WS.send(JSON.stringify({ deviceId: DEVICE_ID, ...payload }));
}

