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

  // ✅ garantuj SENDRECV smer pre audio a pripoj lokálny mikrofón pred SDP
  const audioTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });

  const localAudioTrack = localStream.getAudioTracks?.()[0];
  if (localAudioTrack) {
    try {
      if (audioTransceiver.sender.replaceTrack) {
        void audioTransceiver.sender.replaceTrack(localAudioTrack);
      } else {
        pc.addTrack(localAudioTrack, localStream);
      }
      localAudioTrack.enabled = true;
    } catch (e) {
      console.error("replace/add local audio track failed:", e);
      try {
        pc.addTrack(localAudioTrack, localStream);
      } catch {}
    }
  } else {
    console.warn("⚠️ No local audio track found when creating RTCPeerConnection");
  }

  // ✅ prefer-const (predtým to padalo na 'prefer-const')
  const remote = new MediaStream();

  pc.ontrack = (event: RTCTrackEvent) => {
    if (event.streams && event.streams[0]) {
      onRemoteStream(event.streams[0]);
    } else {
      try {
        remote.addTrack(event.track);
        onRemoteStream(remote);
      } catch {}
    }
  };

  pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
  if (!event.candidate) return;

  const c: RTCIceCandidate = event.candidate;

  // poskladaj RTCIceCandidateInit bez any
  const candidateInit: RTCIceCandidateInit = {
    candidate: c.candidate,
    sdpMid: c.sdpMid ?? undefined,
    sdpMLineIndex: c.sdpMLineIndex ?? undefined,
  };

  // usernameFragment je optional a nemusí byť v type, pridaj cez type guard
  const maybeUF = (c as RTCIceCandidate & { usernameFragment?: string }).usernameFragment;
  if (maybeUF) candidateInit.usernameFragment = maybeUF;

  const payload: WSMessage = {
    type: "webrtc-candidate",
    targetId,
    candidate: candidateInit,
    callId: opts.getCallId ? opts.getCallId() : undefined,
  };
  sendWS(payload);
};


  return pc;
};
