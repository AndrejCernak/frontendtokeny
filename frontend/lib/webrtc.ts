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

  // --- 1) Vždy pripravíme AUDIO transceiver v režime SENDRECV
  // Tým si garantujeme, že SDP bude chcieť prijímať aj posielať audio.
  const audioTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });

  // --- 2) Pripoj lokálny mikrofón ešte pred SDP
  const localAudioTrack = localStream.getAudioTracks?.()[0];
  if (localAudioTrack) {
    try {
      // preferovane: napojíme track priamo na sender transceivera
      if (audioTransceiver.sender.replaceTrack) {
        audioTransceiver.sender.replaceTrack(localAudioTrack);
      } else {
        pc.addTrack(localAudioTrack, localStream);
      }
      // pre istotu nech je povolený
      localAudioTrack.enabled = true;
    } catch (e) {
      console.error("replace/add local audio track failed:", e);
      // fallback – ak by replace zlyhal
      try {
        pc.addTrack(localAudioTrack, localStream);
      } catch {}
    }
  } else {
    console.warn("⚠️ No local audio track found when creating RTCPeerConnection");
  }

  // (Voliteľne: ak by si niekedy chcel pridať ďalšie audio/videá, môžeš ich tiež addTrack-nuť.
  // Ale pre audio-only je transceiver + 1 mikrofón track ideálne.)

  // --- 3) Remote stream handling
  let remote = new MediaStream();
  pc.ontrack = (event: RTCTrackEvent) => {
    // vezmeme prvý stream; ak by nebol, poskladáme ho manuálne
    if (event.streams && event.streams[0]) {
      onRemoteStream(event.streams[0]);
    } else {
      try {
        remote.addTrack(event.track);
        onRemoteStream(remote);
      } catch {}
    }
  };

  // --- 4) ICE kandidáti (s callId)
  pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate) {
      const payload: WSMessage = {
        type: "webrtc-candidate",
        targetId,
        candidate: event.candidate.toJSON ? event.candidate.toJSON() : (event.candidate as any),
        callId: opts.getCallId ? opts.getCallId() : undefined,
      };
      sendWS(payload);
    }
  };

  // (Voliteľné: logy na debug)
  // pc.onconnectionstatechange = () => console.log("PC state:", pc.connectionState);
  // pc.onsignalingstatechange = () => console.log("Signaling:", pc.signalingState);

  return pc;
};
