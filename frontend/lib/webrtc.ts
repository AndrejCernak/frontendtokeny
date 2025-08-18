// lib/webrtc.ts
import { sendWS } from "./wsClient";

type CreatePCOpts = {
  getCallId?: () => string | null;
};

/**
 * Vytvorí RTCPeerConnection, nastaví handlery a posielanie ICE kandidátov.
 * POZOR: zámerne NEPRIDÁVA žiadny lokálny track – to robíme cielene cez `attachMicToPc`
 * v správnom poradí (napr. po setRemoteDescription pri prijatí hovoru).
 */
export const createPeerConnection = (
  _localStream: MediaStream, // vedome nevyužité – nechávame podpis kompatibilný
  targetId: string,
  onRemoteStream: (stream: MediaStream) => void,
  opts: CreatePCOpts = {}
): RTCPeerConnection => {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
  });

  // Posielanie ICE kandidátov peerovi
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    sendWS({
      type: "webrtc-candidate",
      targetId,
      candidate: e.candidate,
      callId: opts.getCallId?.() ?? null,
    });
  };

  // Remote stream prichádza cez ontrack
  pc.ontrack = (ev) => {
    // Väčšina prehliadačov dá stream v ev.streams[0]
    if (ev.streams && ev.streams[0]) {
      onRemoteStream(ev.streams[0]);
      return;
    }
    // Fallback (niektoré implementácie neposielajú streams pole)
    const single = new MediaStream([ev.track]);
    onRemoteStream(single);
  };

  // Voliteľná údržba: ak spadne spojenie, nech si to rieši volajúci kód
  // (v app/page.tsx máš attachPCGuards / hardResetPeerLocally)

  return pc;
};

/**
 * Bezpečne pripojí (alebo nahradí) mikrofón do existujúceho PC.
 * - Ak existuje audio sender, použije replaceTrack.
 * - Ak neexistuje, pridá jediný audio track (a tým vytvorí jednu audio m-line).
 */
export const attachMicToPc = (pc: RTCPeerConnection, localStream: MediaStream): void => {
  const track = localStream.getAudioTracks()[0];
  if (!track) return;

  // Skús nájsť už existujúci audio sender
  const existingAudioSender =
    pc.getSenders().find((s) => s.track?.kind === "audio") ??
    pc.getSenders().find((s) => !s.track); // “prázdny” sender, ak by existoval

  if (existingAudioSender) {
    if (existingAudioSender.track !== track) {
      try {
        existingAudioSender.replaceTrack(track);
      } catch {
        // v krajnom prípade sa nepodarí replaceTrack – potom ešte skúsime addTrack nižšie
      }
    }
    return;
  }

  // Ak audio sender nie je, pridaj track (vznikne len 1 m=audio, keďže PC je bez audio sendera)
  try {
    pc.addTrack(track, localStream);
  } catch {
    // ignoruj – ak by prehliadač padol na addTrack, nech to nezhodí app
  }
};
