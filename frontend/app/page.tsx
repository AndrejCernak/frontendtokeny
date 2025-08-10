"use client";

import { useUser, SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { useEffect, useRef, useState, useCallback } from "react";
import { requestFcmToken } from "@/lib/firebase";
import { connectWS, sendWS } from "@/lib/wsClient";
import { createPeerConnection } from "@/lib/webrtc";

type IncomingCall = {
  from: string;
  callerName: string;
};

function formatSeconds(s: number) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m} min ${sec}s`;
}

export default function HomePage() {
  const { user, isSignedIn } = useUser();

  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [hasNotifications, setHasNotifications] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  const [secondsRemaining, setSecondsRemaining] = useState<number>(0);
  const [inCall, setInCall] = useState(false);

  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callTimerRef = useRef<NodeJS.Timeout | null>(null); // lokálny odpočet UI

  const [pendingOffer, setPendingOffer] = useState<{
    offer: RTCSessionDescriptionInit;
    from: string;
  } | null>(null);

  // ===== Helpers =====
  const fetchBalance = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/balance/${user.id}`);
      const data = await res.json();
      setSecondsRemaining(data?.secondsRemaining ?? 0);
    } catch (e) {
      console.warn("Nepodarilo sa načítať zostatok", e);
    }
  }, [user]);

  const startLocalStream = useCallback(async () => {
    try {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      // pri samotnom audku nič nepriraďujeme do <audio>, to je remote
      console.log("🎤 Local audio tracks:", localStreamRef.current?.getTracks());
    } catch (err) {
      console.error("❌ Chyba pri získavaní mikrofónu:", err);
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

  const startUiCountdown = useCallback(() => {
    clearCallTimer();
    callTimerRef.current = setInterval(() => {
      setSecondsRemaining((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
  }, []);

  const stopCall = useCallback(
    async (targetId?: string) => {
      try {
        if (pc) {
          pc.getSenders().forEach((s) => s.track && s.track.stop());
          pc.close();
          setPc(null);
        }
        localStreamRef.current?.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;

        clearCallTimer();
        setInCall(false);
        setIsMuted(false);

        // požiadaj backend o ukončenie aj druhú stranu (ak máme target)
        if (targetId) {
          sendWS({ type: "end-call", targetId });
        }
      } finally {
        // po ukončení si doťahni presný zostatok zo servera
        await fetchBalance();
      }
    },
    [pc, fetchBalance]
  );

  // ===== Accept / Call =====
  const handleAccept = useCallback(
    async (targetId: string) => {
      if (!localStreamRef.current) await startLocalStream();

      const newPc = createPeerConnection(localStreamRef.current!, targetId, attachRemoteStream);
      setPc(newPc);

      if (pendingOffer && pendingOffer.from === targetId) {
        await newPc.setRemoteDescription(new RTCSessionDescription(pendingOffer.offer));
        const answer = await newPc.createAnswer();
        await newPc.setLocalDescription(answer);
        sendWS({ type: "webrtc-answer", targetId, answer });
        setPendingOffer(null);
      }

      setInCall(true);
      startUiCountdown(); // UI odpočet – server odpočítava každých 10s; UI ide po sekundách
    },
    [startLocalStream, pendingOffer, attachRemoteStream, startUiCountdown]
  );

  const handleCall = useCallback(async () => {
    // rýchla kontrola zostatku pred volaním
    await fetchBalance();
    if (secondsRemaining <= 0) {
      alert("Nemáš dostupné tokeny. Kúp si balík, aby si mohol volať.");
      return;
    }

    if (!localStreamRef.current) await startLocalStream();

    const targetId = "user_30p94nuw9O2UHOEsXmDhV2SgP8N"; // admin ID
    const newPc = createPeerConnection(localStreamRef.current!, targetId, attachRemoteStream);
    setPc(newPc);

    const offer = await newPc.createOffer();
    await newPc.setLocalDescription(offer);

    sendWS({ type: "call-request", targetId, callerName: user?.fullName || "Neznámy" });
    sendWS({ type: "webrtc-offer", targetId, offer, callerId: user?.id });

    setInCall(true);
    startUiCountdown();
  }, [fetchBalance, secondsRemaining, startLocalStream, user, attachRemoteStream, startUiCountdown]);

  const handlePurchaseMvp = useCallback(async () => {
    if (!user) return;
    try {
      // 30 min = 1800 s → 1800 * 0.125 € = 225.00 € (ak 450 €/h)
      const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, amountEur: 225.0 }),
      });
      const data = await res.json();
      if (data?.success) {
        await fetchBalance();
        alert("Kredit navýšený. Môžeš volať 👍");
      } else {
        alert("Nákup zlyhal.");
      }
    } catch (e) {
      alert("Chyba pri nákupe.");
    }
  }, [user, fetchBalance]);

  // ===== WS handling =====
  useEffect(() => {
    if (isSignedIn && user) {
      const role = (user.publicMetadata.role as string) || "client";

      // načítaj zostatok po prihlásení
      fetchBalance();

      connectWS(user.id, role, async (msg) => {
        if (msg.type === "incoming-call") {
          setIncomingCall({ from: msg.callerId as string, callerName: msg.callerName as string });
        }

        if (msg.type === "insufficient-tokens") {
          alert("Nemáš dostupné tokeny. Kúp si balík, aby si mohol volať.");
          setInCall(false);
          clearCallTimer();
        }

        if (msg.type === "call-started") {
          // server potvrdil, že call je reálne spojeny
          setInCall(true);
          startUiCountdown();
        }

        if (msg.type === "end-call") {
          // dôvod: "no-tokens" alebo manual
          await stopCall(msg.from as string | undefined);
        }

        if (msg.type === "webrtc-offer") {
          if (!pc) {
            setPendingOffer({ offer: msg.offer as RTCSessionDescriptionInit, from: msg.callerId as string });
          } else {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.offer as RTCSessionDescriptionInit));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendWS({ type: "webrtc-answer", targetId: msg.callerId, answer });
          }
        }

        if (msg.type === "webrtc-answer") {
          if (!localStreamRef.current) {
            await startLocalStream();
          }
          if (!pc) {
            const newPc = createPeerConnection(localStreamRef.current!, msg.callerId as string, attachRemoteStream);
            setPc(newPc);
            await newPc.setRemoteDescription(new RTCSessionDescription(msg.answer as RTCSessionDescriptionInit));
          } else {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.answer as RTCSessionDescriptionInit));
          }
        }

        if (msg.type === "webrtc-candidate") {
          await pc?.addIceCandidate(new RTCIceCandidate(msg.candidate as RTCIceCandidateInit));
        }

        // voliteľné: ak by si zo servera posielal "balance-update" každých 10s
        if (msg.type === "balance-update") {
          setSecondsRemaining(msg.secondsRemaining as number);
        }
      });
    }

    return () => {
      clearCallTimer();
    };
  }, [isSignedIn, user, pc, startLocalStream, attachRemoteStream, fetchBalance, startUiCountdown, stopCall]);

  // ===== Notifications toggle (bez zmeny) =====
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
      const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/register-fcm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, fcmToken: token, role }),
      });
      if (res.ok) {
        alert("Notifikácie boli povolené ✅");
        setHasNotifications(true);
      } else {
        alert("Chyba pri registrácii tokenu.");
      }
    } catch (err) {
      console.error("FCM chyba:", err);
      alert("Nastala chyba pri nastavovaní notifikácií.");
    }
  }, [user]);

  // ===== UI =====
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
                  Zostatok: <span className="font-semibold">{formatSeconds(secondsRemaining)}</span>
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
                  onClick={handlePurchaseMvp}
                  className="px-4 py-2 rounded-xl bg-amber-500 text-white shadow hover:bg-amber-600 transition"
                >
                  Kúpiť 30 min (225 €)
                </button>
              </div>
            </div>
          </section>

          <section className="rounded-2xl bg-white/80 backdrop-blur shadow-sm border border-stone-200 p-6">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex-1">
                <h2 className="text-lg font-semibold mb-1">Stav hovoru</h2>
                <p className="text-stone-600 text-sm">
                  {incomingCall ? `Prichádzajúci hovor od: ${incomingCall.callerName}` : inCall ? "Prebieha hovor" : "Pripravený na hovor"}
                </p>
              </div>

              {user?.publicMetadata.role === "client" && (
                <button
                  disabled={secondsRemaining <= 0 || inCall}
                  className={`px-5 py-3 rounded-xl font-medium shadow transition
                    ${secondsRemaining <= 0 || inCall ? "bg-stone-300 text-stone-500 cursor-not-allowed"
                                                      : "bg-emerald-600 text-white hover:bg-emerald-700"}`}
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
                  onClick={() => stopCall(incomingCall?.from)}
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
            Tip: Ak nič nepočuť, skontroluj povolenia mikrofónu v prehliadači a systémové nastavenia výstupného zvuku.
          </p>
        </SignedIn>
      </div>
    </main>
  );
}