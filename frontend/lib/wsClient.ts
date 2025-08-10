let ws: WebSocket | null = null;

export function connectWS(userId: string, email: string, onMessage: (msg: any) => void) {
  const url = process.env.NEXT_PUBLIC_BACKEND_URL!;
  const wsUrl = url.replace(/^http/i, "ws"); // http(s) -> ws(s)

  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    ws?.send(JSON.stringify({ type: "register", userId, email })); // ← posielame email
  };
  ws.onmessage = (ev) => {
    try { onMessage(JSON.parse(ev.data as string)); } catch {}
  };
  ws.onclose = () => {
    setTimeout(() => connectWS(userId, email, onMessage), 2000);
  };
}

export function sendWS(payload: any) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
