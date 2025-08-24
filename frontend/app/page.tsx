"use client";

import {
  useUser,
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
} from "@clerk/nextjs";
import { useAuth } from "@clerk/nextjs";
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import { requestFcmToken } from "@/lib/firebase";
import { connectWS, sendWS, DEVICE_ID } from "@/lib/wsClient";
import { attachMicToPc, createPeerConnection } from "@/lib/webrtc";

type IncomingCall = { callId: string; from: string; callerName: string };

function isFridayInBratislava(d = new Date()) {
  const local = new Date(
    d.toLocaleString("en-US", { timeZone: "Europe/Bratislava" })
  );
  return local.getDay() === 5; // 0=Sun ... 5=Fri
}

export default function HomePage() {
  const { user, isSignedIn } = useUser();
  const { getToken } = useAuth();
  const role = (user?.publicMetadata.role as string) || "client";

  const userEmail =
  (user?.primaryEmailAddress && (user.primaryEmailAddress as any).emailAddress) ||
  user?.emailAddresses?.find((e: any) => e.id === user?.primaryEmailAddressId)?.emailAddress ||
  user?.emailAddresses?.[0]?.emailAddress ||
  "";

  // ——— Call state
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [, setPc] = useState<RTCPeerConnection | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [hasNotifications, setHasNotifications] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return (
      Notification.permission === "granted" ||
      localStorage.getItem("fcm-enabled") === "1"
    );
  });
  const [isMuted, setIsMuted] = useState(false);
  const [inCall, setInCall] = useState(false);

  // ——— Call timer
const [callStartAt, setCallStartAt] = useState<number | null>(null);
const [callElapsed, setCallElapsed] = useState<number>(0); // sekundy
const callElapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

function formatElapsed(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function startCallTimer() {
  if (callElapsedTimerRef.current) clearInterval(callElapsedTimerRef.current);
  const start = Date.now();
  setCallStartAt(start);
  setCallElapsed(0);
  callElapsedTimerRef.current = setInterval(() => {
    setCallElapsed(Math.floor((Date.now() - start) / 1000));
  }, 1000);
}

function stopCallTimer() {
  if (callElapsedTimerRef.current) {
    clearInterval(callElapsedTimerRef.current);
    callElapsedTimerRef.current = null;
  }
  setCallStartAt(null);
  setCallElapsed(0);
}


  // ——— Balances
  const [fridayMinutesRemaining, setFridayMinutesRemaining] = useState<number>(0);
  const isFriday = useMemo(() => isFridayInBratislava(), []);

  // ——— Media/WS helpers
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const callIdRef = useRef<string | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  const [peerAccepted, setPeerAccepted] = useState(false);
  const [remoteConnected, setRemoteConnected] = useState(false);

  const [pendingOffer, setPendingOffer] = useState<{
    offer: RTCSessionDescriptionInit;
    from: string;
  } | null>(null);

  // ===== Backend helpers =====
  const backend = process.env.NEXT_PUBLIC_BACKEND_URL!;
  const adminId = process.env.NEXT_PUBLIC_ADMIN_ID as string;

  // ---------- Diagnostics helpers ----------
  function attachDeepRtcLogs(pc: RTCPeerConnection, tag: string) {
    pc.onicegatheringstatechange = () => console.log(`[${tag}] iceGatheringState=`, pc.iceGatheringState);
    pc.oniceconnectionstatechange = async () => {
      const s = pc.iceConnectionState;
      console.log(`[${tag}] iceConnectionState=`, s);
      if (s === "disconnected") {
        console.warn(`[${tag}] ICE disconnected → request-offer`);
        if (peerIdRef.current) {
          sendWSWithLog({ type: "request-offer", targetId: peerIdRef.current, callId: callIdRef.current });
        }
      }
      if (s === "failed") {
        console.warn(`[${tag}] ICE failed → iceRestart offer`);
        if (peerIdRef.current) await sendNewOffer(peerIdRef.current);
      }
    };
    pc.onsignalingstatechange = () => console.log(`[${tag}] signalingState=`, pc.signalingState);
    pc.onconnectionstatechange = () => console.log(`[${tag}] connectionState=`, pc.connectionState);
    pc.onicecandidateerror = (e: any) => console.warn(`[${tag}] onicecandidateerror`, e);
    pc.onnegotiationneeded = () => console.log(`[${tag}] onnegotiationneeded`);
pc.ontrack = (ev) => {
  console.log(
    "[TRACK] remote kind=", ev.track?.kind,
    "muted=", ev.track?.muted,
    "streams=", ev.streams?.[0]?.id
  );
  ev.track.onunmute = () => console.log("[TRACK] remote onunmute");
  ev.track.onmute = () => console.log("[TRACK] remote onmute");
  attachRemoteStream(ev.streams[0]);
  forcePlayRemoteAudio();
};
  }

  const sendWSWithLog = (payload: any) => {
    console.log("[WS->] sending", payload?.type, {
      targetId: payload?.targetId,
      hasCallId: !!payload?.callId,
      deviceId: payload?.deviceId,
    });
    sendWS(payload);
  };

  const fetchFridayBalance = useCallback(async () => {
    if (!user) return 0;
    const res = await fetch(`${backend}/friday/balance/${user.id}`);
    const data = await res.json();
    const m = data?.totalMinutes ?? 0;
    setFridayMinutesRemaining(m);
    return m;
  }, [backend, user]);

  const startLocalStream = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });

      const at = stream.getAudioTracks()[0];
      if (at) {
        at.enabled = true;
        at.onmute = () => console.log("[MIC] track muted");
        at.onunmute = () => console.log("[MIC] track unmuted");
        at.onended = () => console.log("[MIC] track ended");
      }


      localStreamRef.current = stream;

      // ak už PC existuje, pripoj/nahraď mic track do existujúceho PC
      if (pcRef.current) {
        attachMicToPc(pcRef.current, stream);
      }
    } catch (e) {
      console.error("❌ Mikrofón - getUserMedia failed", e);
      alert("Nepodarilo sa získať prístup k mikrofónu.");
    }
  }, []);

  const toggleMute = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks?.()[0];
    if (track) {
      track.enabled = !track.enabled;
      setIsMuted(!track.enabled ? true : false);
    }
  }, []);

  const attachRemoteStream = useCallback((stream: MediaStream) => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = stream;
      remoteAudioRef.current.play().catch(() => {});
      forcePlayRemoteAudio();

    }
  }, []);

  // --- AUDIO: vynútené prehratie a event logy
function forcePlayRemoteAudio() {
  const a = remoteAudioRef.current;
  if (!a) return;
  a.muted = false;
  a.volume = 1.0;
  (a as any).playsInline = true; // iOS
  a.autoplay = true;

  a.onplay = () => console.log("[AUDIO] onplay");
  a.onpause = () => console.log("[AUDIO] onpause");
  a.oncanplay = () => console.log("[AUDIO] oncanplay");
  a.onerror = (e) => console.log("[AUDIO] onerror", e);

  a.play()
    .then(() => console.log("[AUDIO] play() resolved; readyState=", a.readyState, "paused=", a.paused))
    .catch(err => console.warn("[AUDIO] play() failed:", err?.name, err?.message));
}

// --- STATS: sleduj bajty dnu/von (na odhalenie, či tečie audio)
let statsTimer: ReturnType<typeof setInterval> | null = null;

async function logAudioStats(pc: RTCPeerConnection, tag: string) {
  try {
    const stats = await pc.getStats();
    let inBytes = 0, outBytes = 0, jitter = 0;
    stats.forEach((r: any) => {
      if (r.type === "inbound-rtp" && r.kind === "audio") { inBytes = r.bytesReceived || 0; jitter = r.jitter || 0; }
      if (r.type === "outbound-rtp" && r.kind === "audio") { outBytes = r.bytesSent || 0; }
    });
    console.log(`[STATS ${tag}] inBytes=${inBytes} outBytes=${outBytes} jitter=${jitter}`);
  } catch {}
}


  const clearCallTimer = () => {
    if (callTimerRef.current) {
      clearTimeout(callTimerRef.current);
      callTimerRef.current = null;
    }
  };

  // tiché „prebudenie“ audio na iOS pred prvým play()
  const nudgeAudio = useCallback(() => {
    const a = remoteAudioRef.current;
    if (!a) return;
    try {
      a.muted = true;
      a.play().then(() => {
        a.pause();
        a.muted = false;
      }).catch(() => {});
    } catch {}
  }, []);

  // 🔧 tvrdý lokálny reset peeru/streamov/audia bez WS správ
  const hardResetPeerLocally = useCallback((opts?: { preserveSignaling?: boolean }) => {
    try {
      if (pcRef.current) {
        pcRef.current.onicecandidate = null;
        pcRef.current.ontrack = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.getSenders().forEach((s) => s.track && s.track.stop());
        pcRef.current.close();
      }
    } catch {}
    pcRef.current = null;
    setPc(null);

    try {
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {}
    localStreamRef.current = null;

    if (remoteAudioRef.current) {
      try {
        remoteAudioRef.current.srcObject = null;
        remoteAudioRef.current.pause();
        remoteAudioRef.current.currentTime = 0;
      } catch {}
    }

    stopCallTimer(); // ✅ pre istotu zastav aj tu
    // UI/reset stavov
    setIncomingCall(null);
    setIsMuted(false);
    setInCall(false);
    peerIdRef.current = null;
    callIdRef.current = null;
    clearCallTimer();

    if (!opts?.preserveSignaling) {
      pendingCandidatesRef.current = [];
      setPendingOffer(null);
    }
  if (statsTimer) {
  clearInterval(statsTimer);
  statsTimer = null;
}

  }, []);

  // helper: ak PC neexistuje alebo je closed/failed, vytvor nový
  const ensureFreshPC = useCallback(
    (targetId: string) => {
      const stale =
        pcRef.current &&
        (pcRef.current.connectionState === "closed" ||
          pcRef.current.connectionState === "failed");
      if (!pcRef.current || stale) {
        const newPc = createPeerConnection(
          localStreamRef.current!,
          targetId,
          attachRemoteStream,
          { getCallId: () => callIdRef.current }
        );
        attachPCGuards(newPc);
        attachDeepRtcLogs(newPc, role === "admin" ? "ADMIN" : "CLIENT");
        pcRef.current = newPc;
        setPc(newPc);
        peerIdRef.current = targetId;
        (window as any).debugPeer = newPc;
      }
      return pcRef.current!;
    },
    [attachRemoteStream, role]
  );

  // malý guard na PC stav (ak spadne, uprac, nech ďalšie volanie ide hneď)
  const attachPCGuards = useCallback(
    (peer: RTCPeerConnection) => {
      peer.onconnectionstatechange = () => {
        const s = peer.connectionState;
        if (s === "connected") {
          setPeerAccepted(true);
          setRemoteConnected(true);
          startCallTimer(); // ✅ spusti timer
        }
        if (s === "disconnected" || s === "failed" || s === "closed") {
          setRemoteConnected(false);
          stopCallTimer(); // ✅ zastav timer
          hardResetPeerLocally();
        }
      };

      ;

      // Keď dorazí prvý remote track, určite sme „napojení“
      peer.ontrack = (ev) => {
      attachRemoteStream(ev.streams[0]);
      setPeerAccepted(true);
      setRemoteConnected(true);
      startCallTimer(); // ✅ spusti timer
    };

    },
    [attachRemoteStream, hardResetPeerLocally]
  );

  const stopCall = useCallback(
    async (targetId?: string, notify = true) => {
      try {
        stopCallTimer(); // ✅ zastav timer
        const id = targetId ?? peerIdRef.current ?? undefined;
        if (id && notify) {
          sendWSWithLog({ type: "end-call", targetId: id, callId: callIdRef.current });
        }

        if (pcRef.current) {
          pcRef.current.onicecandidate = null;
          pcRef.current.ontrack = null;
          pcRef.current.onconnectionstatechange = null;
          pcRef.current.getSenders().forEach((s) => s.track && s.track.stop());
          try { pcRef.current.close(); } catch {}
        }
        pcRef.current = null;
        setPc(null);

        try { localStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
        localStreamRef.current = null;

        if (remoteAudioRef.current) {
          try {
            remoteAudioRef.current.srcObject = null;
            remoteAudioRef.current.pause();
            remoteAudioRef.current.currentTime = 0;
          } catch {}
        }

        clearCallTimer();
        setPendingOffer(null);
        setIncomingCall(null);
        setIsMuted(false);
        setInCall(false);
      } finally {
        peerIdRef.current = null;
        callIdRef.current = null;
        await fetchFridayBalance();
      }
    if (statsTimer) {
  clearInterval(statsTimer);
  statsTimer = null;
}

    },
    [fetchFridayBalance]
    
  );

  type TransceiverDirWritable = RTCRtpTransceiver & {
    setDirection?: (dir: RTCRtpTransceiverDirection) => void;
    direction?: RTCRtpTransceiverDirection;
  };

  // ===== Accept / Call =====
  const handleAccept = useCallback(
    async (targetId: string) => {
      // reset bez zmazania signalizačných bufferov (offer + ICE)
      hardResetPeerLocally({ preserveSignaling: true });
      setPeerAccepted(false);
      setRemoteConnected(false);
      setIncomingCall(null);

      // vždy načítaj mikrofón nanovo
      await startLocalStream();
      console.log(
        "Admin local tracks:",
        localStreamRef.current?.getTracks()?.map((t) => `${t.kind}:${t.readyState}`)
      );

      // vytvor nové PC
      const newPc = createPeerConnection(
        localStreamRef.current!,
        targetId,
        attachRemoteStream,
        { getCallId: () => callIdRef.current }
      );
      attachPCGuards(newPc);
      attachDeepRtcLogs(newPc, "ADMIN");
      pcRef.current = newPc;
      setPc(newPc);
      peerIdRef.current = targetId;
      (window as any).debugPeer = newPc;

      // musí existovať pending offer
      const po = pendingOffer;
      if (!po?.offer) {
        console.error("Žiadna pending offer pri prijatí hovoru.");
        return;
      }

      try {
        // nastav remote offer
        await newPc.setRemoteDescription(new RTCSessionDescription(po.offer));

        // flush pending candidates (prišli pred answerom)
        if (pendingCandidatesRef.current.length) {
          console.log("Flushing buffered ICE (admin):", pendingCandidatesRef.current.length);
          for (const c of pendingCandidatesRef.current) {
            try { await newPc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {
              console.error("flush addIceCandidate (admin):", e);
            }
          }
          pendingCandidatesRef.current = [];
        }

        // vynúť audio transceiver na 'sendrecv'
        let at = newPc.getTransceivers().find(
          (t) =>
            t.receiver?.track?.kind === "audio" ||
            t.sender?.track?.kind === "audio"
        ) as TransceiverDirWritable | undefined;
        if (!at) {
          at = newPc.addTransceiver("audio", { direction: "sendrecv" }) as TransceiverDirWritable;
        } else {
          if (typeof at.setDirection === "function") at.setDirection("sendrecv");
          else if (typeof at.direction !== "undefined") at.direction = "sendrecv";
        }

        // pripoj/nahraď mikrofón do PC
        if (localStreamRef.current) {
          attachMicToPc(newPc, localStreamRef.current);
          console.log("Admin senders:",
            newPc.getSenders().map(s => s.track && `${s.track.kind}:${s.track.readyState}`));
        }

        // vytvor a nastav answer
        const answer = await newPc.createAnswer();
        await newPc.setLocalDescription(answer);

        // pošli answer späť volajúcemu
        sendWSWithLog({
          type: "webrtc-answer",
          targetId,
          answer,
          callId: callIdRef.current,
          deviceId: DEVICE_ID,
        });

        // skús spustiť prehrávanie remote audia (mobilné prehliadače)
        if (remoteAudioRef.current) {
          try {
            await remoteAudioRef.current.play();
          } catch {}
        }

        setPendingOffer(null);
        setInCall(true);
        if (statsTimer) clearInterval(statsTimer);
        statsTimer = setInterval(() => {
          if (pcRef.current) logAudioStats(pcRef.current, "ADMIN");
        }, 2000);


        // bezpečnostný timeout – len pri skutočnom faili
        if (callTimerRef.current) clearTimeout(callTimerRef.current);
        callTimerRef.current = setTimeout(() => {
          const states = {
            ice: pcRef.current?.iceConnectionState,
            conn: pcRef.current?.connectionState,
          };
          console.warn("Safety timeout hit (60s). States:", states);
          if (
            pcRef.current?.connectionState === "failed" ||
            pcRef.current?.iceConnectionState === "failed"
          ) {
            hardResetPeerLocally();
          }
        }, 60000);
      } catch (err) {
        console.error("handleAccept error:", err);
        hardResetPeerLocally();
      }
    },
    [
      pendingOffer,
      startLocalStream,
      attachRemoteStream,
      attachPCGuards,
      sendWSWithLog,
      setIncomingCall,
      setPendingOffer,
      setInCall,
      hardResetPeerLocally,
    ]
  );

  const handleCall = useCallback(async () => {
    if (!user) return;

    // čistý lokálny reset pred novým hovorom
    hardResetPeerLocally();
    setPeerAccepted(false);
    setRemoteConnected(false);

    callIdRef.current = null;

    await nudgeAudio();

    if (isFriday) {
      const m = await fetchFridayBalance();
      if (m <= 0) {
        alert(
          "V piatok môžeš volať iba s piatkovými tokenmi. Skús kúpiť token alebo burzu."
        );
        window.location.href = "/burza-tokenov";
        return;
      }
    }
    // mimo piatku: volanie zadarmo

    if (!localStreamRef.current) await startLocalStream();

    const targetId = adminId;
    const newPc = createPeerConnection(
      localStreamRef.current!,
      targetId,
      attachRemoteStream,
      { getCallId: () => callIdRef.current }
    );
    attachPCGuards(newPc);
    attachDeepRtcLogs(newPc, "CLIENT");
    setPc(newPc);
    pcRef.current = newPc;
    peerIdRef.current = targetId;
    (window as any).debugPeer = newPc;

    // pripoj mic
    attachMicToPc(newPc, localStreamRef.current!);

    const offer = await newPc.createOffer();
    await newPc.setLocalDescription(offer);

    sendWSWithLog({
      type: "call-request",
      targetId,
      callerName: user?.fullName || userEmail || "Neznámy",
      callerEmail: userEmail,
    });
    sendWSWithLog({
      type: "webrtc-offer",
      targetId,
      offer,
      callerId: user?.id,
      callId: callIdRef.current,
      deviceId: DEVICE_ID,
      callerName: user?.fullName || userEmail || "Neznámy",
      callerEmail: userEmail,
    });


    setInCall(true);
    if (statsTimer) clearInterval(statsTimer);
      statsTimer = setInterval(() => {
        if (pcRef.current) logAudioStats(pcRef.current, "CLIENT");
      }, 2000);


    // bezpečnostný timeout – len pri skutočnom faili
    if (callTimerRef.current) clearTimeout(callTimerRef.current);
    callTimerRef.current = setTimeout(() => {
      const states = {
        ice: pcRef.current?.iceConnectionState,
        conn: pcRef.current?.connectionState,
      };
      console.warn("Safety timeout hit (60s). States:", states);
      if (
        pcRef.current?.connectionState === "failed" ||
        pcRef.current?.iceConnectionState === "failed"
      ) {
        hardResetPeerLocally();
      }
    }, 60000);
  }, [
    user,
    isFriday,
    fetchFridayBalance,
    startLocalStream,
    attachRemoteStream,
    adminId,
    hardResetPeerLocally,
    attachPCGuards,
    nudgeAudio,
  ]);

  const sendNewOffer = useCallback(
    async (targetId: string) => {
      if (!localStreamRef.current) {
        await startLocalStream();
      }

      let pcToUse = pcRef.current;
      if (!pcToUse || ["closed", "failed"].includes(pcToUse.connectionState)) {
        const newPc = createPeerConnection(
          localStreamRef.current!,
          targetId,
          attachRemoteStream,
          { getCallId: () => callIdRef.current }
        );
        attachPCGuards(newPc);
        attachDeepRtcLogs(newPc, role === "admin" ? "ADMIN" : "CLIENT");
        setPc(newPc);
        pcRef.current = newPc;
        peerIdRef.current = targetId;
        pcToUse = newPc;
        (window as any).debugPeer = newPc;
      }

      attachMicToPc(pcToUse, localStreamRef.current!);

      const offer = await pcToUse.createOffer({ iceRestart: true });
      await pcToUse.setLocalDescription(offer);

      sendWSWithLog({
        type: "webrtc-offer",
        targetId,
        offer,
        callerId: user?.id,
        callId: callIdRef.current,
        deviceId: DEVICE_ID,
      });
    },
    [startLocalStream, attachRemoteStream, user, attachPCGuards, role]
  );

  // ===== INIT (sync-user, fetch balance, connect WS, fallback)
  useEffect(() => {
    const init = async () => {
      if (!isSignedIn || !user) return;

      // 1) Sync user do DB (server si vytiahne userId z Bearer JWT)
      try {
        const jwt = await getToken();
        await fetch(`${backend}/sync-user`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({}),
        });
      } catch {
        console.error("sync-user FE error");
      }

      // 2) Načítaj piatkový zostatok
      fetchFridayBalance();

      // 3) Pripoj WS
      connectWS(user.id, role, async (msg) => {
        console.log("[WS<-] recv", msg.type, {
          from: msg.from,
          deviceId: msg.deviceId,
          hasCallId: !!msg.callId,
        });

        if (msg.type === "incoming-call") {
          const nameOrEmail =
            (msg.callerName as string) ||
            (msg.callerEmail as string) ||
            "Neznámy";
          setIncomingCall({
            callId: String(msg.callId),
            from: String(msg.callerId),
            callerName: nameOrEmail,
          });
          callIdRef.current = typeof msg.callId === "string" ? msg.callId : null;
        }


        if (msg.type === "insufficient-friday-tokens") {
          alert(
            "V piatok môžeš volať iba s piatkovými tokenmi. Skús kúpiť token alebo burzu."
          );
          setInCall(false);
          clearCallTimer();
          window.location.href = "/burza-tokenov";
        }

        if (msg.type === "call-started") {
          setIncomingCall(null);
          setInCall(true);
          setPeerAccepted(true); // admin prijal
        }

        if (msg.type === "end-call") {
          setIncomingCall(null);
          await stopCall(undefined, false); // nepotvrdzuj späť
        }

        if (msg.type === "call-locked") {
          setIncomingCall(null);
          setPendingOffer(null);
        }

        if (msg.type === "webrtc-offer") {
          const incomingCallId = typeof msg.callId === "string" ? msg.callId : null;
          callIdRef.current = incomingCallId ?? callIdRef.current;

          // iba uložiť offer a počkať na „Prijať“
          setPendingOffer({
            offer: msg.offer as RTCSessionDescriptionInit,
            from: String(msg.callerId),
          });
        }

        if (msg.type === "webrtc-answer") {
          if (!localStreamRef.current) await startLocalStream();
          const pcLocal = ensureFreshPC(String(msg.callerId));
          await pcLocal.setRemoteDescription(
            new RTCSessionDescription(msg.answer as RTCSessionDescriptionInit)
          );

          // flush pending candidates
          if (pendingCandidatesRef.current.length) {
            console.log("Flushing buffered ICE:", pendingCandidatesRef.current.length);
            for (const c of pendingCandidatesRef.current) {
              try { await pcLocal.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {
                console.error("flush addIceCandidate:", e);
              }
            }
            pendingCandidatesRef.current = [];
          }

          callIdRef.current =
            typeof msg.callId === "string" ? msg.callId : callIdRef.current;
          try {
            remoteAudioRef.current?.play?.();
          } catch {}
        }

        if (msg.type === "webrtc-candidate") {
          const cand = msg.candidate as RTCIceCandidateInit;
          const pcLocal = pcRef.current;

          if (!pcLocal) {
            pendingCandidatesRef.current.push(cand);
            return;
          }

          // ak remoteDescription ešte nie je nastavený, odlož
          if (!pcLocal.remoteDescription) {
            pendingCandidatesRef.current.push(cand);
            return;
          }

          try {
            await pcLocal.addIceCandidate(new RTCIceCandidate(cand));
          } catch (e) {
            console.error("addIceCandidate error:", e);
          }
        }

        if (msg.type === "request-offer") {
          callIdRef.current =
            typeof msg.callId === "string" ? msg.callId : callIdRef.current;
          await sendNewOffer(String(msg.from));
        }

        if (msg.type === "friday-balance-update") {
          setFridayMinutesRemaining(msg.minutesRemaining as number);
        }
      });

      // 4) REST fallback – ak ušla WS správa alebo sa app otvorila z pushky
      try {
        const jwt = await getToken();
        const res = await fetch(`${backend}/calls/pending`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        const data = await res.json();
        if (data?.pending) {
          setIncomingCall({
            callId: String(data.pending.callId),
            from: String(data.pending.callerId),
            callerName: String(data.pending.callerName),
          });
          callIdRef.current =
            typeof data.pending.callId === "string" ? data.pending.callId : null;
        }
      } catch {}
    };

    init();

    // keď sa tab stane viditeľným (otvorenie z notifikácie), skús znova REST fallback
    const onVis = async () => {
      if (document.visibilityState !== "visible") return;
      if (!isSignedIn || !user) return;
      const jwt = await getToken();
      try {
        const res = await fetch(`${backend}/calls/pending`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        const data = await res.json();
        if (data?.pending) {
          setIncomingCall({
            callId: String(data.pending.callId),
            from: String(data.pending.callerId),
            callerName: String(data.pending.callerName),
          });
          callIdRef.current =
            typeof data.pending.callId === "string" ? data.pending.callId : null;
        }
      } catch {}
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      clearCallTimer();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [
    isSignedIn,
    user,
    role,
    startLocalStream,
    attachRemoteStream,
    fetchFridayBalance,
    stopCall,
    sendNewOffer,
    backend,
    getToken,
    attachPCGuards,
    ensureFreshPC,
  ]);

  // ===== Auto-register push on app start when already granted =====
  useEffect(() => {
    const autoRegisterPush = async () => {
      if (!isSignedIn || !user) return;
      if (Notification.permission !== "granted") return;
      try {
        const token = await requestFcmToken();
        if (!token) return;
        const role = (user.publicMetadata.role as string) || "client";
        const jwt = await getToken();

        await fetch(`${backend}/register-fcm`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({
            fcmToken: token,
            role,
            platform: "web",
          }),
        });

        setHasNotifications(true);
        if (typeof window !== "undefined") localStorage.setItem("fcm-enabled", "1");
      } catch {}
    };
    autoRegisterPush();
  }, [isSignedIn, user, backend, getToken]);

  const handleEnableNotifications = useCallback(async () => {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        alert("Notifikácie neboli povolené.");
        return;
      }
      const token = await requestFcmToken();
      if (!token || !user) {
        alert("Nepodarilo sa získať FCM token.");
        return;
      }
      const role = (user.publicMetadata.role as string) || "client";
      const jwt = await getToken();

      const res = await fetch(`${backend}/register-fcm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          fcmToken: token,
          role,
          platform: "web",
        }),
      });
      if (res.ok) {
        setHasNotifications(true);
        if (typeof window !== "undefined") localStorage.setItem("fcm-enabled", "1");
        alert("Notifikácie boli povolené ✅");
      } else {
        alert("Chyba pri registrácii tokenu.");
      }
    } catch (err) {
      console.error("FCM chyba:", err);
      alert("Nastala chyba pri nastavovaní notifikácií.");
    }
  }, [backend, user, getToken]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-100 via-emerald-50 to-amber-50 text-stone-800">
      <div className="max-w-3xl mx-auto p-6">
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-emerald-600/10 flex items-center justify-center shadow-inner">
              <span className="text-emerald-700 font-bold">🔊</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Audio hovory</h1>
          </div>
          <div className="flex items-center gap-3">
            <SignedOut>
              <SignInButton />
            </SignedOut>
            <SignedIn>
              <UserButton />
            </SignedIn>
          </div>
        </header>

        <SignedIn>
          <section className="rounded-2xl bg-white/80 backdrop-blur shadow-sm border border-stone-200 p-5 mb-5">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <p className="text-sm text-stone-500">Prihlásený používateľ</p>
                <p className="font-medium">{user?.fullName || userEmail}</p>
                <p className="text-sm text-stone-600 mt-1">
                  Piatkové minúty:{" "}
                  <span className="font-semibold">{fridayMinutesRemaining} min</span>
                </p>
              </div>

              <div className="flex items-center gap-2">
                {!hasNotifications && (
                  <button
                    className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700 transition"
                    onClick={handleEnableNotifications}
                  >
                    Povoliť notifikácie
                  </button>
                )}
                <button
                  onClick={() => (window.location.href = "/burza-tokenov")}
                  className="px-4 py-2 rounded-xl bg-amber-500 text-white shadow hover:bg-amber-600 transition"
                >
                  Burza piatkových tokenov
                </button>
              </div>
            </div>
          </section>

          <section className="rounded-2xl bg-white/80 backdrop-blur shadow-sm border border-stone-200 p-6">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex-1">
                <h2 className="text-lg font-semibold mb-1">Stav hovoru</h2>
                <p className="text-stone-600 text-sm flex items-center gap-3">
                  <span>
                    {incomingCall
                      ? `Prichádzajúci hovor od: ${incomingCall.callerName}`
                      : inCall && !peerAccepted
                      ? "Volám… Čakám na prijatie druhej strany."
                      : inCall && peerAccepted && !remoteConnected
                      ? "Prijaté, pripájam…"
                      : inCall && remoteConnected
                      ? "Prebieha hovor – pripojené."
                      : "Pripravený na hovor"}
                  </span>

                  {inCall && (peerAccepted || remoteConnected) && callStartAt && (
                    <span className="px-2 py-1 rounded-md bg-stone-100 border border-stone-200 font-mono tabular-nums">
                      {formatElapsed(callElapsed)}
                    </span>
                  )}
                </p>


                <p className="text-xs text-stone-500 mt-1">
                  {isFriday
                    ? "Piatok: volanie len s piatkovými tokenmi."
                    : "Mimo piatku: volanie je zadarmo."}
                </p>
              </div>

              {user?.publicMetadata.role === "client" && (
                <button
                  disabled={(isFriday ? fridayMinutesRemaining <= 0 : false) || inCall}
                  className={`px-5 py-3 rounded-xl font-medium shadow transition
                    ${
                      (isFriday ? fridayMinutesRemaining <= 0 : false) || inCall
                        ? "bg-stone-300 text-stone-500 cursor-not-allowed"
                        : "bg-emerald-600 text-white hover:bg-emerald-700"
                    }`}
                  onClick={handleCall}
                >
                  Zavolať
                </button>
              )}

              {user?.publicMetadata.role === "admin" && incomingCall && (
                <div className="flex items-center gap-3">
                  <div className="px-3 py-2 rounded-xl bg-amber-100 text-amber-800 font-medium">
                    📞 Volá: {incomingCall.callerName}
                  </div>
                  <button
                    className="px-5 py-3 rounded-xl bg-emerald-600 text-white font-medium shadow hover:bg-emerald-700 transition"
                    onClick={() => handleAccept(incomingCall.from)}
                  >
                    Prijať
                  </button>
                </div>
              )}

              {inCall && (
                <div className="flex items-center gap-2">
                  <button
                    className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700 transition"
                    onClick={toggleMute}
                  >
                    {isMuted ? "Unmute" : "Mute"}
                  </button>
                  <button
                    className="px-4 py-2 rounded-xl bg-stone-700 text-white shadow hover:bg-stone-800 transition"
                    onClick={() => stopCall()}
                  >
                    Ukončiť hovor
                  </button>
                </div>
              )}
            </div>

            {/* 🔈 remote audio */}
            <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
          </section>

          <p className="text-xs text-stone-500 mt-4">
            Tip: Ak nič nepočuť, skontroluj povolenia mikrofónu v prehliadači a
            systémové nastavenia výstupného zvuku.
          </p>
        </SignedIn>
      </div>
    </main>
  );
}
