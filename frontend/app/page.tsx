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

// ---------------- Types ----------------
type IncomingCall = { callId: string; from: string; callerName: string };

type AudioOutputDevice = {
  deviceId: string;
  label: string;
};

function isFridayInBratislava(d = new Date()) {
  const local = new Date(
    d.toLocaleString("en-US", { timeZone: "Europe/Bratislava" })
  );
  return local.getDay() === 5; // 0=Sun ... 5=Fri
}

// ---------------- Component ----------------
export default function HomePage() {
  const { user, isSignedIn } = useUser();
  const { getToken } = useAuth();
  const role = (user?.publicMetadata.role as string) || "client";

  const userEmail =
    (user?.primaryEmailAddress && (user.primaryEmailAddress as any).emailAddress) ||
    user?.emailAddresses?.find((e: any) => e.id === user?.primaryEmailAddressId)?.emailAddress ||
    user?.emailAddresses?.[0]?.emailAddress ||
    "";
  const displayName =
    (user?.fullName && user.fullName.trim()) ||
    [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
    (user?.username as string) ||
    userEmail ||
    "Neznámy";

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

  // ——— Friday minutes
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

  // ===== NEW: audio outputs ("reproduktor" vs "pri uchu") =====
  const [audioOutputs, setAudioOutputs] = useState<AudioOutputDevice[]>([]);
  const [selectedSinkId, setSelectedSinkId] = useState<string>("");
  const [speakerMode, setSpeakerMode] = useState<boolean>(true); // true=reproduktor, false=pri uchu
  const [sinkSupport, setSinkSupport] = useState<boolean>(false);

  const detectSinkSupport = useCallback(() => {
    const a = remoteAudioRef.current as any;
    setSinkSupport(!!(a && typeof a.setSinkId === "function"));
  }, []);

  const enumerateOutputs = useCallback(async () => {
    try {
      if (!localStreamRef.current) {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outs = devices
        .filter((d) => d.kind === "audiooutput")
        .map((d) => ({ deviceId: d.deviceId, label: d.label || "Audio výstup" }));
      setAudioOutputs(outs);
      const speakerish = outs.find((o) => /speaker|reprodukt/i.test(o.label));
      setSelectedSinkId((speakerish?.deviceId || outs[0]?.deviceId || "default") as string);
    } catch (e) {
      // ignore – some platforms (iOS Safari) don't expose outputs
    }
  }, []);

  const applySink = useCallback(
    async (sinkId: string) => {
      try {
        const a = remoteAudioRef.current as any;
        if (!a || typeof a.setSinkId !== "function") return;
        await a.setSinkId(sinkId || "default");
      } catch (e) {
        console.warn("setSinkId failed", e);
      }
    },
    []
  );

  // ---------- Diagnostics helpers ----------
  function attachDeepRtcLogs(pc: RTCPeerConnection, tag: string) {
    pc.addEventListener("icegatheringstatechange", () =>
      console.log(`[${tag}] iceGatheringState=`, pc.iceGatheringState)
    );

    pc.addEventListener("iceconnectionstatechange", async () => {
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
    });

    pc.addEventListener("signalingstatechange", () =>
      console.log(`[${tag}] signalingState=`, pc.signalingState)
    );
    pc.addEventListener("connectionstatechange", () =>
      console.log(`[${tag}] connectionState=`, pc.connectionState)
    );
    pc.addEventListener("icecandidateerror", (e: any) =>
      console.warn(`[${tag}] onicecandidateerror`, e)
    );
    pc.addEventListener("negotiationneeded", () =>
      console.log(`[${tag}] onnegotiationneeded`)
    );

    pc.addEventListener("track", (ev: any) => {
      console.log("[TRACK]", { kind: ev.track?.kind, muted: ev.track?.muted, stream: ev.streams?.[0]?.id });
    });
  }

  const sendWSWithLog = (payload: any) => {
    console.log("[WS->] sending", payload?.type, {
      targetId: payload?.targetId,
      hasCallId: !!payload?.callId,
      deviceId: payload?.deviceId,
    });
    sendWS(payload);
  };

  const backend = process.env.NEXT_PUBLIC_BACKEND_URL!;
  const adminId = process.env.NEXT_PUBLIC_ADMIN_ID as string;

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
      .catch((err) => console.warn("[AUDIO] play() failed:", err?.name, err?.message));
  }

  // --- STATS: useRef to avoid crashes/leaks across renders
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startStats = useCallback((tag: string) => {
    if (statsTimerRef.current) clearInterval(statsTimerRef.current);
    if (!pcRef.current) return;
    statsTimerRef.current = setInterval(async () => {
      try {
        const stats = await pcRef.current!.getStats();
        let inBytes = 0,
          outBytes = 0,
          jitter = 0;
        stats.forEach((r: any) => {
          if (r.type === "inbound-rtp" && r.kind === "audio") {
            inBytes = r.bytesReceived || 0;
            jitter = r.jitter || 0;
          }
          if (r.type === "outbound-rtp" && r.kind === "audio") {
            outBytes = r.bytesSent || 0;
          }
        });
        console.log(`[STATS ${tag}] inBytes=${inBytes} outBytes=${outBytes} jitter=${jitter}`);
      } catch {}
    }, 2000);
  }, []);
  const stopStats = useCallback(() => {
    if (statsTimerRef.current) clearInterval(statsTimerRef.current);
    statsTimerRef.current = null;
  }, []);

  const clearCallTimer = () => {
    if (callTimerRef.current) {
      clearTimeout(callTimerRef.current);
      callTimerRef.current = null;
    }
  };

  const nudgeAudio = useCallback(() => {
    const a = remoteAudioRef.current;
    if (!a) return;
    try {
      a.muted = true;
      a.play()
        .then(() => {
          a.pause();
          a.muted = false;
        })
        .catch(() => {});
    } catch {}
  }, []);

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

    stopStats();
    stopCallTimer();
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
  }, [stopStats]);

  const attachPCGuards = useCallback(
    (peer: RTCPeerConnection) => {
      peer.onconnectionstatechange = () => {
        const s = peer.connectionState;
        if (s === "connected") {
          setPeerAccepted(true);
          setRemoteConnected(true);
          startCallTimer();
          detectSinkSupport();
          // try to apply sink if supported (safe no-op otherwise)
          applySink(selectedSinkId);
          startStats(role === "admin" ? "ADMIN" : "CLIENT");
        }
        if (s === "disconnected" || s === "failed" || s === "closed") {
          setRemoteConnected(false);
          stopCallTimer();
          stopStats();
          hardResetPeerLocally();
        }
      };

      peer.ontrack = (ev) => {
        attachRemoteStream(ev.streams[0]);
        setPeerAccepted(true);
        setRemoteConnected(true);
        startCallTimer();
        detectSinkSupport();
        applySink(selectedSinkId);
        startStats(role === "admin" ? "ADMIN" : "CLIENT");
      };
    },
    [attachRemoteStream, hardResetPeerLocally, detectSinkSupport, selectedSinkId, applySink, startStats, stopStats, role]
  );

  const ensureFreshPC = useCallback(
    async (targetId: string) => {
      // Guarantee we have a local stream before creating PC
      if (!localStreamRef.current) {
        await startLocalStream();
        if (!localStreamRef.current) throw new Error("No local stream available");
      }
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
    [attachRemoteStream, role, startLocalStream, attachPCGuards]
  );

  const stopCall = useCallback(
    async (targetId?: string, notify = true) => {
      try {
        stopCallTimer();
        const id = targetId ?? peerIdRef.current ?? undefined;
        if (id && notify) {
          sendWSWithLog({ type: "end-call", targetId: id, callId: callIdRef.current });
        }

        if (pcRef.current) {
          pcRef.current.onicecandidate = null;
          pcRef.current.ontrack = null;
          pcRef.current.onconnectionstatechange = null;
          pcRef.current.getSenders().forEach((s) => s.track && s.track.stop());
          try {
            pcRef.current.close();
          } catch {}
        }
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
      stopStats();
    },
    [fetchFridayBalance, stopStats]
  );

  type TransceiverDirWritable = RTCRtpTransceiver & {
    setDirection?: (dir: RTCRtpTransceiverDirection) => void;
    direction?: RTCRtpTransceiverDirection;
  };

  // ===== Accept / Call =====
  const handleAccept = useCallback(
    async (targetId: string) => {
      hardResetPeerLocally({ preserveSignaling: true });
      setPeerAccepted(false);
      setRemoteConnected(false);
      setIncomingCall(null);

      await startLocalStream();
      if (!localStreamRef.current) return alert("Mikrofón nie je dostupný");

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

      const po = pendingOffer;
      if (!po?.offer) {
        console.error("Žiadna pending offer pri prijatí hovoru.");
        return;
      }

      try {
        if (newPc.signalingState !== "stable") {
          await newPc.setLocalDescription(); // no-op ensures stable transitions
        }
        await newPc.setRemoteDescription(new RTCSessionDescription(po.offer));

        if (pendingCandidatesRef.current.length) {
          for (const c of pendingCandidatesRef.current) {
            try {
              await newPc.addIceCandidate(new RTCIceCandidate(c));
            } catch (e) {
              console.error("flush addIceCandidate (admin):", e);
            }
          }
          pendingCandidatesRef.current = [];
        }

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

        if (localStreamRef.current) {
          attachMicToPc(newPc, localStreamRef.current);
        }

        const answer = await newPc.createAnswer();
        await newPc.setLocalDescription(answer);

        sendWSWithLog({
          type: "webrtc-answer",
          targetId,
          answer,
          callId: callIdRef.current,
          deviceId: DEVICE_ID,
        });

        try {
          await remoteAudioRef.current?.play?.();
        } catch {}

        setPendingOffer(null);
        setInCall(true);

        if (callTimerRef.current) clearTimeout(callTimerRef.current);
        callTimerRef.current = setTimeout(() => {
          const failed =
            pcRef.current?.connectionState === "failed" ||
            pcRef.current?.iceConnectionState === "failed";
          if (failed) hardResetPeerLocally();
        }, 60000);
      } catch (err) {
        console.error("handleAccept error:", err);
        hardResetPeerLocally();
      }
    },
    [pendingOffer, startLocalStream, attachRemoteStream, attachPCGuards, sendWSWithLog, hardResetPeerLocally]
  );

  const handleCall = useCallback(async () => {
    if (!user) return;

    hardResetPeerLocally();
    setPeerAccepted(false);
    setRemoteConnected(false);

    callIdRef.current = null;

    await nudgeAudio();

    if (isFriday) {
      const m = await fetchFridayBalance();
      if (m <= 0) {
        alert("V piatok môžeš volať iba s piatkovými tokenmi. Skús kúpiť token alebo burzu.");
        window.location.href = "/burza-tokenov";
        return;
      }
    }

    if (!localStreamRef.current) await startLocalStream();
    if (!localStreamRef.current) return alert("Mikrofón nie je dostupný");

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

    attachMicToPc(newPc, localStreamRef.current!);

    const offer = await newPc.createOffer();
    await newPc.setLocalDescription(offer);

    sendWSWithLog({ type: "call-request", targetId, callerName: displayName, callerEmail: userEmail });

    sendWSWithLog({
      type: "webrtc-offer",
      targetId,
      offer,
      callerId: user?.id,
      callId: callIdRef.current,
      deviceId: DEVICE_ID,
      callerName: displayName,
      callerEmail: userEmail,
    });

    setInCall(true);

    if (callTimerRef.current) clearTimeout(callTimerRef.current);
    callTimerRef.current = setTimeout(() => {
      const failed =
        pcRef.current?.connectionState === "failed" ||
        pcRef.current?.iceConnectionState === "failed";
      if (failed) hardResetPeerLocally();
    }, 60000);
  }, [user, isFriday, fetchFridayBalance, startLocalStream, attachRemoteStream, adminId, hardResetPeerLocally, attachPCGuards, nudgeAudio, displayName, userEmail]);

  const sendNewOffer = useCallback(
    async (targetId: string) => {
      if (!localStreamRef.current) {
        await startLocalStream();
      }
      if (!localStreamRef.current) return;

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

  // ===== INIT (sync-user, balance, WS, REST fallback) =====
  useEffect(() => {
    const init = async () => {
      if (!isSignedIn || !user) return;

      try {
        const jwt = await getToken();
        await fetch(`${backend}/sync-user`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({}),
        });
      } catch {
        console.error("sync-user FE error");
      }

      fetchFridayBalance();

      connectWS(user.id, role, async (msg) => {
        console.log("[WS<-] recv", msg.type, { from: msg.from, deviceId: msg.deviceId, hasCallId: !!msg.callId });

        if (msg.type === "incoming-call") {
          const nameOrEmail = (msg.callerName as string) || (msg.callerEmail as string) || "Neznámy";
          setIncomingCall({ callId: String(msg.callId), from: String(msg.callerId), callerName: nameOrEmail });
        }

        if (msg.type === "insufficient-friday-tokens") {
          alert("V piatok môžeš volať iba s piatkovými tokenmi. Skús kúpiť token alebo burzu.");
          setInCall(false);
          clearCallTimer();
          window.location.href = "/burza-tokenov";
        }

        if (msg.type === "call-started") {
          setIncomingCall(null);
          setInCall(true);
          setPeerAccepted(true);
        }

        if (msg.type === "end-call") {
          setIncomingCall(null);
          await stopCall(undefined, false);
        }

        if (msg.type === "call-locked") {
          setIncomingCall(null);
          setPendingOffer(null);
        }

        if (msg.type === "webrtc-offer") {
          const incomingCallId = typeof msg.callId === "string" ? msg.callId : null;
          callIdRef.current = incomingCallId ?? callIdRef.current;
          setPendingOffer({ offer: msg.offer as RTCSessionDescriptionInit, from: String(msg.callerId) });
        }

        if (msg.type === "webrtc-answer") {
          await ensureFreshPC(String(msg.callerId));
          const pcLocal = pcRef.current!;
          try {
            await pcLocal.setRemoteDescription(new RTCSessionDescription(msg.answer as RTCSessionDescriptionInit));
          } catch (e) {
            console.error("setRemoteDescription failed", e);
          }

          if (pendingCandidatesRef.current.length) {
            for (const c of pendingCandidatesRef.current) {
              try {
                await pcLocal.addIceCandidate(new RTCIceCandidate(c));
              } catch (e) {
                console.error("flush addIceCandidate:", e);
              }
            }
            pendingCandidatesRef.current = [];
          }

          callIdRef.current = typeof msg.callId === "string" ? msg.callId : callIdRef.current;
          try {
            remoteAudioRef.current?.play?.();
          } catch {}
        }

        if (msg.type === "webrtc-candidate") {
          const cand = msg.candidate as RTCIceCandidateInit;
          const pcLocal = pcRef.current;

          if (!pcLocal || !pcLocal.remoteDescription) {
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
          callIdRef.current = typeof msg.callId === "string" ? msg.callId : callIdRef.current;
          await sendNewOffer(String(msg.from));
        }

        if (msg.type === "friday-balance-update") {
          setFridayMinutesRemaining(msg.minutesRemaining as number);
        }
      });

      // 4) REST fallback – ak ušla WS správa alebo sa app otvorila z pushky
      try {
        const jwt = await getToken();
        const res = await fetch(`${backend}/calls/pending`, { headers: { Authorization: `Bearer ${jwt}` } });
        const data = await res.json();
        if (data?.pending) {
          setIncomingCall({ callId: String(data.pending.callId), from: String(data.pending.callerId), callerName: String(data.pending.callerName) });
          callIdRef.current = typeof data.pending.callId === "string" ? data.pending.callId : null;
        }
      } catch {}

      detectSinkSupport();
      enumerateOutputs();
    };

    init();

    const onVis = async () => {
      if (document.visibilityState !== "visible") return;
      if (!isSignedIn || !user) return;
      const jwt = await getToken();
      try {
        const res = await fetch(`${backend}/calls/pending`, { headers: { Authorization: `Bearer ${jwt}` } });
        const data = await res.json();
        if (data?.pending) {
          setIncomingCall({ callId: String(data.pending.callId), from: String(data.pending.callerId), callerName: String(data.pending.callerName) });
          callIdRef.current = typeof data.pending.callId === "string" ? data.pending.callId : null;
        }
      } catch {}
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      clearCallTimer();
      document.removeEventListener("visibilitychange", onVis);
      stopStats();
    };
  }, [isSignedIn, user, role, fetchFridayBalance, backend, getToken, stopCall, sendNewOffer, ensureFreshPC, detectSinkSupport, enumerateOutputs, stopStats]);

  // ===== Auto-register push when granted =====
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
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({ fcmToken: token, role, platform: "web" }),
        });

        setHasNotifications(true);
        if (typeof window !== "undefined") localStorage.setItem("fcm-enabled", "1");
      } catch {}
    };
    autoRegisterPush();
  }, [isSignedIn, user, backend, getToken]);

  // ===== NEW: Speaker / Earpiece toggle logic =====
  const handleSpeakerToggle = useCallback(async () => {
    const next = !speakerMode; // compute next first to avoid stale state
    setSpeakerMode(next);
    const a = remoteAudioRef.current as any;
    if (!a) return;

    if (typeof a.setSinkId === "function" && audioOutputs.length) {
      const speaker = audioOutputs.find((d) => /speaker|reprodukt/i.test(d.label));
      const comm = audioOutputs.find((d) => /communication|slúchad|ear|phone|receiver/i.test(d.label));
      const nextId = next ? (speaker?.deviceId || selectedSinkId || "default") : (comm?.deviceId || "default");
      setSelectedSinkId(nextId);
      await applySink(nextId);
    } else {
      try {
        await a.pause();
        await a.play();
      } catch {}
    }
  }, [audioOutputs, speakerMode, selectedSinkId, applySink]);

  // ===== Enable Notifications Handler =====
  const handleEnableNotifications = useCallback(async () => {
    if (typeof window === "undefined" || typeof Notification === "undefined") return;
    try {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        setHasNotifications(true);
        if (typeof window !== "undefined") localStorage.setItem("fcm-enabled", "1");
      }
    } catch (e) {
      console.error("Failed to enable notifications", e);
    }
  }, []);

  // =================== UI ===================
  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-100 via-emerald-50 to-amber-50 text-stone-800">
      <div className="max-w-3xl mx-auto p-6">
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-2xl bg-emerald-600/10 flex items-center justify-center shadow-inner">
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
          {/* USER CARD */}
          <section className="rounded-2xl bg-white/80 backdrop-blur shadow-sm border border-stone-200 p-5 mb-5">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <p className="text-sm text-stone-500">Prihlásený používateľ</p>
                <p className="font-medium">{displayName}</p>
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

          {/* CALL HUD */}
          <section className="rounded-3xl overflow-hidden border border-stone-200 shadow-sm">
            {/* Top area: big gradient tile acting like phone in-call screen */}
            <div className="relative isolate bg-gradient-to-br from-emerald-600 to-amber-500 text-white p-6 sm:p-8">
              <div className="absolute inset-0 -z-10 opacity-20" style={{ background: "radial-gradient(1200px 400px at 20% 10%, rgba(255,255,255,.6), transparent)" }} />

              <div className="flex items-start sm:items-center justify-between gap-6 flex-col sm:flex-row">
                <div className="flex items-center gap-4">
                  <div className="h-14 w-14 sm:h-16 sm:w-16 rounded-2xl bg-white/15 backdrop-blur flex items-center justify-center shadow-inner">
                    <span className="text-xl font-bold">
                      {displayName
                        .split(" ")
                        .map((p: string) => p.charAt(0))
                        .slice(0, 2)
                        .join("")}
                    </span>
                  </div>

                  <div>
                    <p className="text-white/90 text-sm">{incomingCall ? "Prichádzajúci hovor" : inCall ? "Hovor" : "Pripravený"}</p>
                    <h2 className="text-2xl sm:text-3xl font-semibold leading-tight">
                      {incomingCall ? incomingCall.callerName : displayName}
                    </h2>

                    <div className="mt-1 flex items-center gap-2 text-white/90 text-sm">
                      {inCall && (peerAccepted || remoteConnected) && callStartAt ? (
                        <span className="font-mono tabular-nums px-2 py-0.5 rounded-md bg-white/10">
                          {formatElapsed(callElapsed)}
                        </span>
                      ) : null}
                      <span className="opacity-90">
                        {incomingCall
                          ? `Volá: ${incomingCall.callerName}`
                          : inCall && !peerAccepted
                          ? "Volám… Čakám na prijatie druhej strany."
                          : inCall && peerAccepted && !remoteConnected
                          ? "Prijaté, pripájam…"
                          : inCall && remoteConnected
                          ? "Prebieha hovor – pripojené."
                          : isFriday
                          ? "Piatok: volanie len s piatkovými tokenmi."
                          : "Mimo piatku: volanie je zadarmo."}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Animated call waves */}
                <div className="flex items-center gap-1 h-12">
                  <span className="w-1.5 rounded-full bg-white/70 animate-[pulse_1.4s_ease-in-out_infinite]" />
                  <span className="w-1.5 rounded-full bg-white/60 animate-[pulse_1.6s_ease-in-out_infinite]" />
                  <span className="w-1.5 rounded-full bg-white/50 animate-[pulse_1.8s_ease-in-out_infinite]" />
                  <span className="w-1.5 rounded-full bg-white/40 animate-[pulse_2s_ease-in-out_infinite]" />
                </div>
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-3">
                {user?.publicMetadata.role === "client" && (
                  <button
                    disabled={(isFriday ? fridayMinutesRemaining <= 0 : false) || inCall}
                    onClick={handleCall}
                    className={`px-5 py-3 rounded-2xl font-medium shadow transition ${
                      (isFriday ? fridayMinutesRemaining <= 0 : false) || inCall
                        ? "bg-white/20 text-white/70 cursor-not-allowed"
                        : "bg-white text-stone-900 hover:bg-amber-50"
                    }`}
                  >
                    Zavolať
                  </button>
                )}

                {user?.publicMetadata.role === "admin" && incomingCall && (
                  <button
                    onClick={() => handleAccept(incomingCall.from)}
                    className="px-5 py-3 rounded-2xl bg-white text-stone-900 font-medium shadow hover:bg-emerald-50 transition"
                  >
                    Prijať
                  </button>
                )}

                {inCall && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={toggleMute}
                      className="px-4 py-2 rounded-xl bg-white/15 text-white shadow-inner hover:bg-white/25 transition"
                    >
                      {isMuted ? "Unmute" : "Mute"}
                    </button>
                    <button
                      onClick={() => stopCall()}
                      className="px-4 py-2 rounded-xl bg-stone-900/60 text-white shadow-inner hover:bg-stone-900/80 transition"
                    >
                      Ukončiť
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Bottom area: device + speaker/ear controls */}
            <div className="bg-white/80 backdrop-blur p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="text-stone-600 text-sm">Výstup zvuku</span>
                {sinkSupport && audioOutputs.length > 0 ? (
                  <select
                    className="px-3 py-2 rounded-xl border border-stone-300 bg-white shadow-sm text-sm"
                    value={selectedSinkId}
                    onChange={async (e) => {
                      const v = e.target.value || "default";
                      setSelectedSinkId(v);
                      await applySink(v);
                    }}
                  >
                    {audioOutputs.map((o) => (
                      <option key={o.deviceId} value={o.deviceId}>
                        {o.label || "Audio výstup"}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-stone-500 text-sm">
                    Prepínanie výstupu nie je v tomto prehliadači dostupné
                  </span>
                )}
              </div>

              {/* Speaker/Ear toggle */}
              <div className="flex items-center gap-3">
                <span className="text-sm text-stone-600">Reproduktor</span>
                <button
                  onClick={handleSpeakerToggle}
                  className={`relative inline-flex h-7 w-14 items-center rounded-full transition ${
                    speakerMode ? "bg-emerald-600" : "bg-stone-300"
                  }`}
                >
                  <span
                    className={`inline-block h-6 w-6 transform rounded-full bg-white shadow transition ${
                      speakerMode ? "translate-x-7" : "translate-x-1"
                    }`}
                  />
                </button>
                <span className="text-sm text-stone-600">Pri uchu</span>
              </div>
            </div>

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
