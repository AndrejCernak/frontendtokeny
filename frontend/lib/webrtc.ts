// lib/webrtc.ts

import { sendWS, DEVICE_ID } from "./wsClient";

export function createPeerConnection(
  localStream: MediaStream,
  targetId: string,
  onRemoteStream: (s: MediaStream) => void,
  opts?: { getCallId?: () => string | null }
) {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      {
        urls: [
          "turns:TURN_HOST:443?transport=tcp", // ← doplň svoj TURN server
          "turn:TURN_HOST:3478?transport=udp",
        ],
        username: process.env.NEXT_PUBLIC_TURN_USER || "TURN_USER",
        credential: process.env.NEXT_PUBLIC_TURN_PASS || "TURN_PASS",
      },
    ],
  });

  // remote stream handler
  pc.ontrack = (ev) => {
    if (ev.streams && ev.streams[0]) {
      onRemoteStream(ev.streams[0]);
    }
  };

  // ICE kandidáty posielaj hneď cez WS
  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      sendWS({
        type: "webrtc-candidate",
        targetId,
        candidate: ev.candidate.toJSON(),
        callId: opts?.getCallId?.() || null,
        deviceId: DEVICE_ID,
      });
    }
  };

  // pridaj lokálne tracky (ak sú)
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  return pc;
}

// Robustné pripojenie mikrofónu k peer connection
export function attachMicToPc(pc: RTCPeerConnection, stream: MediaStream) {
  const track = stream.getAudioTracks()[0];
  if (!track) return;

  const audioSender = pc.getSenders().find((s) => s.track?.kind === "audio");
  if (audioSender) {
    console.log("Replacing audio track in existing sender");
    audioSender.replaceTrack(track);
  } else {
    console.log("Adding new audio track to PC");
    pc.addTrack(track, stream);
  }
}
