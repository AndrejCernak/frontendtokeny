// /lib/webrtc.ts
// Spoľahlivé pripojenie mikrofónu + správne posielanie ICE kandidátov s deviceId & callId.

import { sendWS, DEVICE_ID } from "@/lib/wsClient";

type CreatePcOptions = {
  getCallId?: () => string | null | undefined;
};

/**
 * Pripojí/nahradí mikrofónový audio track do RTCPeerConnection.
 * - ak už audio sender existuje: replaceTrack(track)
 * - inak: addTrack(track, stream)
 */
export function attachMicToPc(pc: RTCPeerConnection, stream: MediaStream) {
  if (!pc || !stream) return;
  const track = stream.getAudioTracks()[0];
  if (!track) {
    console.warn("attachMicToPc: stream nemá audio track.");
    return;
  }

  // pre istotu zapni track
  try {
    track.enabled = true;
  } catch {}

  const existingSender = pc
    .getSenders()
    .find((s) => s.track?.kind === "audio");

  if (existingSender) {
    // nahradenie existujúceho tracku
    existingSender.replaceTrack(track).catch((e) => {
      console.error("replaceTrack error:", e);
    });
  } else {
    // prvé pripojenie
    try {
      pc.addTrack(track, stream);
    } catch (e) {
      console.error("addTrack error:", e);
    }
  }
}

/**
 * Vytvorí a nakonfiguruje RTCPeerConnection.
 * - nastaví STUNy (možeš nahradiť za vlastné)
 * - pripojí mikrofón, ak je dostupný
 * - nastaví ontrack → odovzdá remote stream do callbacku
 * - posiela ICE kandidátov s deviceId a callId (dôležité pre multi-device)
 */
export function createPeerConnection(
  localStream: MediaStream | null,
  targetId: string,
  onRemoteStream: (stream: MediaStream) => void,
  opts: CreatePcOptions = {}
): RTCPeerConnection {
  const pc = new RTCPeerConnection({
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" } // free Google STUN
  ]
});


  // Ak máme lokálny stream, pripoj mikrofón (nezakladá to duplicitné sendery, replaceTrack to kryje)
  if (localStream) {
    try {
      attachMicToPc(pc, localStream);
    } catch (e) {
      console.error("attachMicToPc(initial) error:", e);
    }
  }

  // Remote stream handling
  pc.ontrack = (ev) => {
    // uprednostni stream z ev.streams, ak je k dispozícii
    const remoteStream = ev.streams?.[0] ?? new MediaStream([ev.track]);
    onRemoteStream(remoteStream);
  };

  // ICE candidates → WS (s deviceId + callId kvôli multi-device routingu)
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    try {
      const callId = opts.getCallId?.() ?? null;
      sendWS({
        type: "webrtc-candidate",
        targetId,
        candidate: e.candidate,
        callId,           // musí byť rovnaký ako pri offer/answer
        deviceId: DEVICE_ID,
      });
    } catch (err) {
      console.error("onicecandidate -> sendWS error:", err);
    }
  };

  // Voliteľná diagnostika
  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === "failed") {
      console.warn("ICE failed; you may want to restart ICE.");
    }
  };

  return pc;
}
