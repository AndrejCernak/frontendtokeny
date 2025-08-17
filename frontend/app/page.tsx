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
import { connectWS, sendWS } from "@/lib/wsClient";
import { createPeerConnection } from "@/lib/webrtc";

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

  // ——— Call state
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
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

  // ——— Balances
  const [fridayMinutesRemaining, setFridayMinutesRemaining] = useState<number>(0);
  const isFriday = useMemo(() => isFridayInBratislava(), []);

  // ——— Media/WS helpers
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callTimerRef = useRef<NodeJS.Timeout | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const callIdRef = useRef<string | null>(null);
  

  const [pendingOffer, setPendingOffer] = useState<{
    offer: RTCSessionDescriptionInit;
    from: string;
  } | null>(null);

  // ===== Backend helpers =====
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


  // úplne hore pri ostatných useCallback/helperoch v page.tsx
const hardResetPeerLocally = useCallback(() => {
  try {
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      // voliteľne:
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
    }
  } catch {}
  pcRef.current = null;
  setPc(null);

  try {
    localStreamRef.current?.getTracks().forEach(t => t.stop());
  } catch {}
  localStreamRef.current = null;

  if (remoteAudioRef.current) {
    try {
      remoteAudioRef.current.srcObject = null;
      remoteAudioRef.current.pause();
      remoteAudioRef.current.currentTime = 0;
    } catch {}
  }

  setPendingOffer(null);
  setIncomingCall(null);
  setIsMuted(false);
  setInCall(false);
  peerIdRef.current = null;
  callIdRef.current = null;
}, []);


  const startLocalStream = useCallback(async () => {
    try {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
    } catch (err) {
      console.error("❌ Mikrofón:", err);
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
    }
  }, []);

  const clearCallTimer = () => {
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }
  };

  const stopCall = useCallback(async (targetId?: string) => {
  try {
    const id = targetId ?? peerIdRef.current ?? undefined;
    if (id) sendWS({ type: "end-call", targetId: id, callId: callIdRef.current });

    // Zavri PC a odstráň handlerov
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.getSenders().forEach(s => s.track && s.track.stop());
      pcRef.current.close();
    }
    pcRef.current = null;
    setPc(null);

    // Zastav lokálne streamy
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;

    // 🔧 Reset remote audio – inak niekedy prehliadač blokne ďalšie autoPlay
    if (remoteAudioRef.current) {
      try {
        remoteAudioRef.current.srcObject = null; // HTMLAudioElement dedí srcObject z HTMLMediaElement
        remoteAudioRef.current.pause();
        remoteAudioRef.current.currentTime = 0;
      } catch {}
    }


    // Vyčisti interný stav
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
}, [fetchFridayBalance]);


  // ===== Accept / Call =====
  const handleAccept = useCallback(
    async (targetId: string) => {
      hardResetPeerLocally();
      setIncomingCall(null);
      if (!localStreamRef.current) await startLocalStream();

      const newPc = createPeerConnection(
        localStreamRef.current!,
        targetId,
        attachRemoteStream,
        { getCallId: () => callIdRef.current }   // <= pridané
      );
      setPc(newPc);
      pcRef.current = newPc;
      peerIdRef.current = targetId;

      if (pendingOffer && pendingOffer.from === targetId) {
        await newPc.setRemoteDescription(
          new RTCSessionDescription(pendingOffer.offer)
        );
        const answer = await newPc.createAnswer();
        await newPc.setLocalDescription(answer);
        sendWS({
          type: "webrtc-answer",
          targetId,
          answer,
          callId: callIdRef.current,
        });
        setPendingOffer(null);
        try {
          remoteAudioRef.current?.play?.();
        } catch {}
      } else {
        // ak admin otvorí PWA až po push-ke, vyžiada si offer pre konkrétny callId
        sendWS({ type: "request-offer", targetId, callId: callIdRef.current });
      }

      setInCall(true);
    },
    [startLocalStream, pendingOffer, attachRemoteStream]
  );

  const handleCall = useCallback(async () => {
    if (!user) return;

    hardResetPeerLocally();

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
      { getCallId: () => callIdRef.current }   // <= pridané

    );
    setPc(newPc);
    pcRef.current = newPc;
    peerIdRef.current = targetId;

    const offer = await newPc.createOffer();
    await newPc.setLocalDescription(offer);

    sendWS({
      type: "call-request",
      targetId,
      callerName: user?.fullName || "Neznámy",
    });
    sendWS({
      type: "webrtc-offer",
      targetId,
      offer,
      callerId: user?.id,
      callId: callIdRef.current,
    });

    setInCall(true);
  }, [
    user,
    isFriday,
    fetchFridayBalance,
    startLocalStream,
    attachRemoteStream,
    adminId,
  ]);

  const sendNewOffer = useCallback(
    async (targetId: string) => {
      if (!localStreamRef.current) {
        await startLocalStream();
      }

      let pcToUse = pc;
      if (!pcToUse) {
        const newPc = createPeerConnection(
          localStreamRef.current!,
          targetId,
          attachRemoteStream,
            { getCallId: () => callIdRef.current }   // <= pridané

        );
        setPc(newPc);
        peerIdRef.current = targetId;
        pcToUse = newPc;
      }

      const offer = await pcToUse.createOffer({ iceRestart: true });
      await pcToUse.setLocalDescription(offer);

      sendWS({
        type: "webrtc-offer",
        targetId,
        offer,
        callerId: user?.id,
        callId: callIdRef.current,
      });
    },
    [pc, startLocalStream, attachRemoteStream, user]
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
      } catch (e) {
        console.error("sync-user FE error:", e);
      }

      // 2) Načítaj piatkový zostatok
      fetchFridayBalance();

      // 3) Pripoj WS
      connectWS(user.id, role, async (msg) => {
        if (msg.type === "incoming-call") {
          setIncomingCall({
            callId: String(msg.callId),
            from: String(msg.callerId),
            callerName: String(msg.callerName),
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
        }

        if (msg.type === "end-call") {
          setIncomingCall(null);
          await stopCall(msg.from as string | undefined);
        }

        if (msg.type === "webrtc-offer") {
          const pcLocal = pcRef.current;
          const incomingCallId = typeof msg.callId === "string" ? msg.callId : null;
          if (!pcLocal) {
            setPendingOffer({
              offer: msg.offer as RTCSessionDescriptionInit,
              from: String(msg.callerId),
            });
            callIdRef.current = incomingCallId ?? callIdRef.current;
          } else {
            await pcLocal.setRemoteDescription(
              new RTCSessionDescription(msg.offer as RTCSessionDescriptionInit)
            );
            const answer = await pcLocal.createAnswer();
            await pcLocal.setLocalDescription(answer);
            sendWS({
              type: "webrtc-answer",
              targetId: msg.callerId,
              answer,
              callId: incomingCallId ?? callIdRef.current,
            });
            try { remoteAudioRef.current?.play?.(); } catch {}
          }
        }


        if (msg.type === "webrtc-answer") {
  if (!localStreamRef.current) await startLocalStream();

      let pcLocal = pcRef.current;
      if (!pcLocal) {
        const newPc = createPeerConnection(
          localStreamRef.current!,
          msg.callerId as string,
          attachRemoteStream,
          { getCallId: () => callIdRef.current }
        );
        setPc(newPc);
        pcRef.current = newPc;
        peerIdRef.current = msg.callerId as string;
        pcLocal = newPc;
      }

      await pcLocal.setRemoteDescription(
        new RTCSessionDescription(msg.answer as RTCSessionDescriptionInit)
      );

      callIdRef.current = typeof msg.callId === "string" ? msg.callId : callIdRef.current;
      try { remoteAudioRef.current?.play?.(); } catch {}
    }


        if (msg.type === "webrtc-candidate") {
          const pcLocal = pcRef.current;
          if (pcLocal) {
            await pcLocal.addIceCandidate(
              new RTCIceCandidate(msg.candidate as RTCIceCandidateInit)
            );
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
          callIdRef.current = typeof data.pending.callId === "string" ? data.pending.callId : null;
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
            callId: data.pending.callId,
            from: data.pending.callerId,
            callerName: data.pending.callerName,
          });
          callIdRef.current = data.pending.callId;
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
      } catch (_) {}
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
                <p className="font-medium">{user?.fullName}</p>
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
                {role !== "admin" && (
                  <button
                    onClick={() => (window.location.href = "/burza-tokenov")}
                    className="px-4 py-2 rounded-xl bg-amber-500 text-white shadow hover:bg-amber-600 transition"
                  >
                    Burza piatkových tokenov
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-2xl bg-white/80 backdrop-blur shadow-sm border border-stone-200 p-6">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex-1">
                <h2 className="text-lg font-semibold mb-1">Stav hovoru</h2>
                <p className="text-stone-600 text-sm">
                  {incomingCall
                    ? `Prichádzajúci hovor od: ${incomingCall.callerName}`
                    : inCall
                    ? "Prebieha hovor"
                    : "Pripravený na hovor"}
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

              <div className="flex items-center gap-2">
                <button
                  className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700 transition"
                  onClick={toggleMute}
                  disabled={!inCall}
                >
                  {isMuted ? "Unmute" : "Mute"}
                </button>
                <button
                  className="px-4 py-2 rounded-xl bg-stone-700 text-white shadow hover:bg-stone-800 transition disabled:opacity-50"
                  onClick={() => stopCall()}
                  disabled={!inCall}
                >
                  Ukončiť hovor
                </button>
              </div>
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
