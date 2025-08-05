type WSMessage = {
  type: string;
  [key: string]: unknown;
};

let ws: WebSocket | null = null;

export const connectWS = (
  userId: string,
  role: string,
  onMessage?: (msg: WSMessage) => void
) => {
  ws = new WebSocket(process.env.NEXT_PUBLIC_BACKEND_URL!.replace(/^http/, "ws"));

  ws.onopen = () => {
    ws?.send(JSON.stringify({ type: "register", userId, role }));
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
};

export const sendWS = (data: object) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
};
