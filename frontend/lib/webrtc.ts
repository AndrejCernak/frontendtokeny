// lib/webrtc.ts
import { sendWS } from "./wsClient";

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

  // pridaj lokálny audio track len raz pri čerstvom PC
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
 * Bezpečne “pripne” mikrofón do existujúceho PC bez duplicitných m-lines:
 * - ak existuje audio sender → replaceTrack, ak je potrebné
 * - inak vytvorí transceiver (sendrecv) a zoberie jeho sender
 */
export const attachMicToPc = (pc: RTCPeerConnection, localStream: MediaStream) => {
  const track = localStream.getAudioTracks()[0];
  if (!track) return;

  const existingSender =
    pc.getSenders().find((s) => s.track?.kind === "audio") ||
    pc.getSenders().find((s) => !s.track);

  const ensuredSender =
    existingSender ?? pc.addTransceiver("audio", { direction: "sendrecv" }).sender;

  if (ensuredSender.track !== track) {
    try {
      ensuredSender.replaceTrack(track);
    } catch {}
  }
};
