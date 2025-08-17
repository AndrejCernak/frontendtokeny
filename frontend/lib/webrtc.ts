// lib/webrtc.ts
import { sendWS } from "./wsClient";

type CreatePCOpts = { getCallId?: () => string | null };

export const createPeerConnection = (
  localStream: MediaStream,
  targetId: string,
  onRemoteStream: (stream: MediaStream) => void,
  opts: CreatePCOpts = {}
) => {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
  });

  // ✅ pridaj lokálny audio track iba pri čerstvom PC
  const t = localStream.getAudioTracks()[0];
  if (t) {
    try { pc.addTrack(t, localStream); } catch {}
  }

  pc.ontrack = (ev: RTCTrackEvent) => {
    const s = ev.streams?.[0];
    if (s) onRemoteStream(s);
  };

  pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
    if (ev.candidate) {
      sendWS({
        type: "webrtc-candidate",
        targetId,
        candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate,
        callId: opts.getCallId ? opts.getCallId() : undefined,
      });
    }
  };

  return pc;
};

export const attachMicToPc = (pc: RTCPeerConnection, localStream: MediaStream) => {
  const track = localStream.getAudioTracks()[0];
  if (!track) return;

  const existingSender =
    pc.getSenders().find(s => s.track?.kind === "audio") ||
    pc.getSenders().find(s => !s.track);

  const sender = existingSender ?? null;

  if (sender) {
    if (sender.track !== track) {
      try { sender.replaceTrack(track); } catch {}
    }
    return;
  }

  // fallback: ak sender nie je, pridaj track (stále 1 m-line, lebo PC je čerstvý/alebo bez sendera)
  try { pc.addTrack(track, localStream); } catch {}
};
