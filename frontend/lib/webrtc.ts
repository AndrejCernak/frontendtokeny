// lib/webrtc.ts
import { sendWS, WSMessage } from "./wsClient";

type CreatePCOpts = {
  getCallId?: () => string | null;
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

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.ontrack = (event: RTCTrackEvent) => {
    const stream = event.streams?.[0];
    if (stream) onRemoteStream(stream);
  };

  pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate) {
      const payload: WSMessage = {
        type: "webrtc-candidate",
        targetId,
        candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
        callId: opts.getCallId ? opts.getCallId() : undefined,
      };
      sendWS(payload);
    }
  };

  return pc;
};
