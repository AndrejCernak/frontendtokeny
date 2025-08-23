// /lib/wsClient.ts
// krátky, ale robustný WS klient: reconnect + queue + heartbeat + logy

let WS: WebSocket | null = null;
let IS_OPEN = false;
let HEARTBEAT: ReturnType<typeof setInterval> | null = null;
let RECON_TIMER: ReturnType<typeof setTimeout> | null = null;
let BACKOFF = 500; // ms (exponenciálne až do 8s)
const MAX_BACKOFF = 8000;
const QUEUE_LIMIT = 200;
const SEND_QUEUE: Record<string, unknown>[] = [];

let CURR_USER_ID: string | null = null;
let CURR_ROLE: string | null = null;
let LAST_PONG_AT = 0;

export const DEVICE_ID =
  (typeof window !== "undefined" &&
    (localStorage.getItem("device-id") ||
      (() => {
        const id = (crypto as any).randomUUID?.() ||
          `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        localStorage.setItem("device-id", id);
        return id;
      })())) ||
  "unknown-device";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001";

type Msg = Record<string, any>;
type Handler = (msg: Msg) => void;
let EXTERNAL_HANDLER: Handler | null = null;

function log(...a: any[]) { console.log("[WS]", ...a); }
function warn(...a: any[]) { console.warn("[WS]", ...a); }

function startHeartbeat() {
  stopHeartbeat();
  LAST_PONG_AT = Date.now();
  HEARTBEAT = setInterval(() => {
    if (!WS || WS.readyState !== WebSocket.OPEN) return;
    // simple keepalive
    internalSend({ type: "ping" });
    // ak server neodpovedá dlho, vynúť reconnect
    if (Date.now() - LAST_PONG_AT > 40000) {
      warn("heartbeat timeout → closing");
      try { WS.close(); } catch {}
    }
  }, 15000);
}
function stopHeartbeat() { if (HEARTBEAT) clearInterval(HEARTBEAT); HEARTBEAT = null; }

function scheduleReconnect() {
  if (RECON_TIMER) return;
  const delay = Math.min(BACKOFF + Math.floor(Math.random() * 300), MAX_BACKOFF);
  warn(`reconnect in ${delay}ms`);
  RECON_TIMER = setTimeout(() => {
    RECON_TIMER = null;
    BACKOFF = Math.min(BACKOFF * 2, MAX_BACKOFF);
    if (CURR_USER_ID && CURR_ROLE) {
      _connect(CURR_USER_ID, CURR_ROLE, EXTERNAL_HANDLER || undefined);
    }
  }, delay);
}
function resetBackoff() { BACKOFF = 500; }

function internalSend(payload: Msg) {
  if (!WS || WS.readyState !== WebSocket.OPEN) {
    if (SEND_QUEUE.length >= QUEUE_LIMIT) SEND_QUEUE.shift();
    SEND_QUEUE.push(payload);
    log("queued", payload?.type);
    return;
  }
  try {
    const wire = JSON.stringify({ deviceId: DEVICE_ID, ...payload });
    log("->", payload?.type, { hasCallId: !!payload?.callId, targetId: payload?.targetId });
    WS.send(wire);
  } catch (e) {
    warn("send error", e);
  }
}
function flushQueue() {
  if (!IS_OPEN) return;
  while (SEND_QUEUE.length) internalSend(SEND_QUEUE.shift()!);
}

function bindRecoveryHooks() {
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && WS?.readyState === WebSocket.OPEN) {
        internalSend({ type: "ping" });
      }
    });
  }
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
      if (!WS || WS.readyState !== WebSocket.OPEN) scheduleReconnect();
    });
  }
}

function _connect(userId: string, role: string, onMessage?: Handler) {
  EXTERNAL_HANDLER = onMessage || null;
  CURR_USER_ID = userId;
  CURR_ROLE = role;

  try {
    WS = new WebSocket(WS_URL);
  } catch (e) {
    warn("failed to create socket", e);
    scheduleReconnect();
    return;
  }

  IS_OPEN = false;

  WS.onopen = () => {
    log("open");
    resetBackoff();
    IS_OPEN = true;
    // REGISTER hneď po pripojení (ako doteraz)
    internalSend({ type: "register", userId, role, deviceId: DEVICE_ID });
    // keepalive
    startHeartbeat();
    // flush fronty
    flushQueue();
  };

  WS.onmessage = (ev) => {
    log("<- raw", ev.data);
    let data: Msg | null = null;
    try { data = JSON.parse(ev.data as string); } catch { return; }

    // heartbeat
    if (data?.type === "pong") { LAST_PONG_AT = Date.now(); return; }
    if (data?.type === "ping") { internalSend({ type: "pong" }); return; }

    try { if (data && EXTERNAL_HANDLER) EXTERNAL_HANDLER(data); }
    catch (e) { warn("external handler error", e); }
  };

  WS.onclose = (e) => {
    log("close", e.code, e.reason);
    IS_OPEN = false;
    stopHeartbeat();
    scheduleReconnect();
  };

  WS.onerror = (e) => {
    warn("error", e);
    // necháme dobehnúť onclose → reconnect
  };
}

// ===== verejné API (nezmenené) =====
export function connectWS(userId: string, role: string, onMessage: Handler) {
  bindRecoveryHooks();
  _connect(userId, role, onMessage);
}

export function sendWS(payload: Msg) {
  internalSend(payload);
}
