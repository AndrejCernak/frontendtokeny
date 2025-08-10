type WSMessage = {
  type: string;
  [key: string]: unknown;
};

let ws: WebSocket | null = null;

/**
 * Pripojenie na WebSocket server
 */
export const connectWS = (
  userId: string,
  role: string,
  onMessage?: (msg: WSMessage) => void
) => {
  ws = new WebSocket(process.env.NEXT_PUBLIC_BACKEND_URL!.replace(/^http/, "ws"));

 ws.onopen = () => {
  console.log("✅ WebSocket connected");
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "register", userId, role }));
  } else if (ws) {
    console.warn("⚠️ WebSocket open event fired, but state =", ws.readyState);
    const interval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "register", userId, role }));
        clearInterval(interval);
      }
    }, 50);
  }
};


  ws.onmessage = (event) => {
    try {
      const msg: WSMessage = JSON.parse(event.data);
      console.log("📩 WS Message:", msg);
      if (onMessage) onMessage(msg);
    } catch (err) {
      console.error("❌ WS parse error:", err);
    }
  };

  ws.onclose = () => {
    console.warn("⚠️ WebSocket disconnected");
  };

  ws.onerror = (err) => {
    console.error("❌ WebSocket error:", err);
  };
};

/**
 * Odoslanie správy cez WebSocket
 * Ak WS nie je pripravený, čakáme na pripojenie
 */
export const sendWS = (data: object) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  } else if (ws && ws.readyState === WebSocket.CONNECTING) {
    console.warn("⏳ WebSocket connecting, waiting to send...");
    ws.addEventListener(
      "open",
      () => {
        console.log("📤 Sending queued message:", data);
        ws?.send(JSON.stringify(data));
      },
      { once: true }
    );
  } else {
    console.error("❌ WebSocket not connected");
  }
};
