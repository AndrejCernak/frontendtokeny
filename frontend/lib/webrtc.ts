import { sendWS } from "./wsClient";

export const createPeerConnection = (
  localStream: MediaStream,
  targetId: string,
  onRemoteStream: (stream: MediaStream) => void
) => {
  const pc = new RTCPeerConnection();

  // ➕ Pridať lokálne tracky
  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  // 🧩 Zbieraj vzdialené tracky do jedného streamu
  const remoteStream = new MediaStream();

  pc.ontrack = (event) => {
    console.log("📺 Remote track received:", event.track);
    remoteStream.addTrack(event.track);
    onRemoteStream(remoteStream); // len raz, keď príde nový track
  };

  // 🔁 ICE kandidáti
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      console.log("➡️ Sending ICE candidate", event.candidate);
      sendWS({ type: "webrtc-candidate", targetId, candidate: event.candidate });
    }
  };

  return pc;
};
