// lib/webrtc.ts
import { sendWS, WSMessage } from "./wsClient";

type CreatePCOpts = {
  getCallId?: () => string | null;
};

export const attachMicToPc = (pc: RTCPeerConnection, localStream: MediaStream) => {
  // ensure there is an audio transceiver in sendrecv
  const audioTrans = pc.getTransceivers().find(t => t.sender && t.receiver && t.mid === null /* not yet negotiated? */) 
                  || pc.getTransceivers().find(t => t.receiver?.track?.kind === "audio")
                  || pc.addTransceiver("audio", { direction: "sendrecv" });

  const track = localStream.getAudioTracks()[0];
  if (!track) return;

  // if there's already a sender for audio, replace its track; otherwise addTrack
  const sender = pc.getSenders().find(s => s.track && s.track.kind === "audio") || audioTrans.sender;
  if (sender) {
    try { sender.replaceTrack(track); } catch {}
  } else {
    pc.addTrack(track, localStream);
  }
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

  // ✅ explicitne si pýtame audio transceiver a pripojíme mikrofón
  pc.addTransceiver("audio", { direction: "sendrecv" });
  attachMicToPc(pc, localStream);

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
