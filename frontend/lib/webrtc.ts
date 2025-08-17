// lib/webrtc.ts
import { sendWS } from "./wsClient";

type CreatePCOpts = {
  getCallId?: () => string | null; // vracia aktuálne callId (alebo null)
};

export const createPeerConnection = (
  localStream: MediaStream,
  targetId: string,
  onRemoteStream: (stream: MediaStream) => void,
  opts: CreatePCOpts = {}
) => {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
  });

  // Pridať lokálny stream
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  // Vzdialený stream
  pc.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      onRemoteStream(event.streams[0]);
    }
  };

  // ICE kandidáti (pridáme callId)
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const callId = opts.getCallId ? opts.getCallId() : undefined;
      sendWS({
        type: "webrtc-candidate",
        targetId,
        candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
        callId,
      });
    }
  };

  return pc;
};
