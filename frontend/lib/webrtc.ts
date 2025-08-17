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

  // --- LOKÁLNY AUDIO TRACK ---
  // Namiesto addTrack na celý stream použijeme 1 audio transceiver v režime sendrecv
  // a priamo doň nasadíme mikrofón. Tým predídeme duplikovaným m-line a garantujeme smer.
  const audioTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });

  const localAudio = localStream.getAudioTracks?.()[0];
  if (localAudio) {
    try {
      // pripojime mikrofón skôr, než sa vytvorí SDP (offer/answer)
      void audioTransceiver.sender.replaceTrack(localAudio);
      localAudio.enabled = true;
    } catch (e) {
      console.error("replaceTrack(localAudio) failed, falling back to addTrack:", e);
      try {
        pc.addTrack(localAudio, localStream);
      } catch {}
    }
  } else {
    console.warn("⚠️ createPeerConnection: no local audio track found");
  }

  // --- REMOTE STREAM ---
  const remote = new MediaStream();
  pc.ontrack = (ev: RTCTrackEvent) => {
    if (ev.streams && ev.streams[0]) {
      onRemoteStream(ev.streams[0]);
      return;
    }
    try {
      remote.addTrack(ev.track);
      onRemoteStream(remote);
    } catch {}
  };

  // --- ICE KANDIDÁTI ---
  pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
    if (!ev.candidate) return;

    const c: RTCIceCandidate = ev.candidate;

    // poskladáme RTCIceCandidateInit bez `any`
    const candidateInit: RTCIceCandidateInit = {
      candidate: c.candidate,
      sdpMid: c.sdpMid ?? undefined,
      sdpMLineIndex: c.sdpMLineIndex ?? undefined,
    };
    // usernameFragment je optional – doplníme cez type guard
    const uf = (c as RTCIceCandidate & { usernameFragment?: string }).usernameFragment;
    if (uf) candidateInit.usernameFragment = uf;

    const payload: WSMessage = {
      type: "webrtc-candidate",
      targetId,
      candidate: candidateInit,
      callId: opts.getCallId ? opts.getCallId() : undefined,
    };
    sendWS(payload);
  };

  // (voliteľné debug)
  // pc.onconnectionstatechange = () => console.log("PC:", pc.connectionState);

  return pc;
};
