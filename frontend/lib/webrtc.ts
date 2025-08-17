// lib/webrtc.ts
import { sendWS, WSMessage } from "./wsClient";

type CreatePCOpts = { getCallId?: () => string | null };

// Bez addTrack – budeme používať výhradne transceiver + replaceTrack
export const createPeerConnection = (
  _localStream: MediaStream,           // nechávam signatúru, ale tu ho nepoužívame
  targetId: string,
  onRemoteStream: (stream: MediaStream) => void,
  opts: CreatePCOpts = {}
) => {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
  });

  // Vytvoríme si bidirectional audio m-line
  pc.addTransceiver("audio", { direction: "sendrecv" });

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

// Jediný bod pravdy na pripojenie mikrofónu do m-line
export const attachMicToPc = (pc: RTCPeerConnection, localStream: MediaStream) => {
  const track = localStream.getAudioTracks()[0];
  if (!track) return;

  // Skús nájsť existujúceho audio sendera (môže byť bez tracku)
  let sender = pc.getSenders().find(s => s.track?.kind === "audio") 
            || pc.getSenders().find(s => !s.track);

  if (!sender) {
    // Ak nie je, vytvor transceiver a zober jeho sender
    const trans = pc.addTransceiver("audio", { direction: "sendrecv" });
    sender = trans.sender;
  }

  try { sender.replaceTrack(track); } catch {}
};
