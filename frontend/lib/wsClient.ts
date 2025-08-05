let ws: WebSocket | null = null;

export const connectWS = (userId: string, role: string, onMessage?: (msg: any) => void) => {
  ws = new WebSocket(process.env.NEXT_PUBLIC_BACKEND_URL!.replace(/^http/, "ws"));
  
  ws.onopen = () => {
    ws?.send(JSON.stringify({ type: "register", userId, role }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    console.log("📩 WS Message:", msg);
    if (onMessage) onMessage(msg);
  };
};

export const sendWS = (data: object) => {
  ws?.send(JSON.stringify(data));
};
