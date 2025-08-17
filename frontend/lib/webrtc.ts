// lib/webrtc.ts
import { sendWS } from "./wsClient";

type CreatePCOpts = {
  getCallId?: () => string | null;
};

/**
 * Vytvorí nový RTCPeerConnection a pridá lokálny audio track JEDENKRÁT.
 * Ďalšie re-attache rieši attachMicToPc (nižšie) bez duplikovania m-lines.
 */
export const createPeerConnection = (
  localStream: MediaStream,
  targetId: string,
  onRemoteStream: (stream: MediaStream) => void,
  opts: CreatePCOpts = {}
) => {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
  });

  // ✅ pridaj lokálny audio track iba na čerstvom PC
  const audioTracks = localStream.getAudioTracks();
  if (audioTracks.length) {
    try {
      pc.addTrack(audioTracks[0], localStream);
    } catch {}
  }

  pc.ontrack = (event: RTCTrackEvent) => {
    const stream = event.streams?.[0];
    if (stream) onRemoteStream(stream);
  };

  pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate) {
      sendWS({
        type: "webrtc-candidate",
        targetId,
        candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
        callId: opts.getCallId ? opts.getCallId() : undefined,
      });
    }
  };

  return pc;
};

/**
 * Bezpečne “pripne” mikrofón do existujúceho PC:
 * - ak je audio sender s trackom → ak je iný track, urob replaceTrack
 * - ak je sender bez tracku → replaceTrack
 * - ak nie je sender → addTrack (nevytvára ďalšie m-line; ostáva pri pôvodnej)
 */
export const attachMicToPc = (pc: RTCPeerConnection, localStream: MediaStream) => {
  const track = localStream.getAudioTracks()[0];
  if (!track) return;

  // nájdi existujúci audio sender, prípadne prázdneho sendera
  let sender =
    pc.getSenders().find((s) => s.track?.kind === "audio") ||
    pc.getSenders().find((s) => !s.track);

  if (sender) {
    if (sender.track !== track) {
      try {
        sender.replaceTrack(track);
      } catch {}
    }
    return;
  }

  // fallback: ak by PC nemal žiadny sender (napr. po resete), pridaj track
  try {
    pc.addTrack(track, localStream);
  } catch {}
};
