import { sendWS } from "./wsClient";

export const createPeerConnection = (localStream: MediaStream, targetId: string, onRemoteStream: (stream: MediaStream) => void) => {
  const pc = new RTCPeerConnection();

  // Pridať lokálny stream
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // Keď príde vzdialený stream
  pc.ontrack = (event) => {
    onRemoteStream(event.streams[0]);
  };

  // ICE kandidáti
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendWS({ type: "webrtc-candidate", targetId, candidate: event.candidate });
    }
  };

  return pc;
};