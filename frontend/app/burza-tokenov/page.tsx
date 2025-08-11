"use client";

import { SignedIn, SignedOut, SignInButton, useUser } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";

type TokenPack = {
  id: string;
  tokens: number;        // 1 token = 60 min
  label: string;
  note?: string;
  priceEur: number;      // celková cena
  strikeEur?: number;    // pôvodná cena (na zobrazenie zľavy)
};

// Pomocná funkcia na formátovanie minút
function formatMinutes(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

export default function BurzaTokenovPage() {
  const { user, isSignedIn } = useUser();
  const role = (user?.publicMetadata.role as string) || "client";

  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const minutesRemaining = useMemo(() => Math.max(0, Math.floor(secondsRemaining / 60)), [secondsRemaining]);
  const tokensRemaining = useMemo(() => Math.floor(minutesRemaining / 60), [minutesRemaining]);

  // CENNÍK: nastav si pokojne iné ceny/zľavy
  // Referenčne sme vychádzali z tvojej predošlej ceny 450 €/h => 1 token (60 min) = 450 €
  const packs: TokenPack[] = [
    { id: "t1",  tokens: 1,  label: "Štart",      priceEur: 450 },
    { id: "t3",  tokens: 3,  label: "Pro 3",      priceEur: 1280, strikeEur: 1350, note: "≈ -5%" },
    { id: "t5",  tokens: 5,  label: "Team 5",     priceEur: 2070, strikeEur: 2250, note: "≈ -8%" },
    { id: "t10", tokens: 10, label: "Studio 10",  priceEur: 3960, strikeEur: 4500, note: "≈ -12%" },
  ];

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

  useEffect(() => {
    if (isSignedIn) fetchBalance();
  }, [isSignedIn, fetchBalance]);

  const handleBuy = useCallback(
    async (pack: TokenPack) => {
      if (!user) return;
      try {
        // Očakávaný backend: POST /purchase-tokens { userId, tokens }
        // Backend si sám vypočíta cenu / vytvorí checkout / získa platbu
        const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/purchase-tokens`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.id, tokens: pack.tokens }),
        });

        const data = await res.json();
        if (res.ok && data?.success) {
          // Môžeš sem doplniť redirect na platobnú bránu podľa odpovede (napr. data.checkoutUrl)
          // if (data.checkoutUrl) window.location.href = data.checkoutUrl;
          // Inak len potvrdenie a refresh zostatku
          alert(`Nákup (${pack.tokens} token) prebehol úspešne ✅`);
          await fetchBalance();
        } else {
          alert(data?.message || "Nákup zlyhal.");
        }
      } catch (err) {
        console.error(err);
        alert("Nastala chyba pri spracovaní nákupu.");
      }
    },
    [user, fetchBalance]
  );

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-100 via-emerald-50 to-amber-50 text-stone-800">
      <div className="max-w-5xl mx-auto p-6">
        <header className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-emerald-600/10 flex items-center justify-center shadow-inner">
              <span className="text-emerald-700 font-bold">🪙</span>
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Burza tokenov</h1>
              <p className="text-sm text-stone-600">
                1 token = 60 min volania
              </p>
            </div>
          </div>
          <div>
            <SignedOut>
              <SignInButton />
            </SignedOut>
          </div>
        </header>

        <SignedIn>
          <section className="rounded-2xl bg-white/80 backdrop-blur shadow-sm border border-stone-200 p-5 mb-6">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <p className="text-sm text-stone-500">Prihlásený používateľ</p>
                <p className="font-medium">{user?.fullName}</p>
                <p className="text-sm text-stone-600 mt-1">
                  Zostatok:{" "}
                  <span className="font-semibold">
                    {formatMinutes(minutesRemaining)} ({tokensRemaining} token{tokensRemaining === 1 ? "" : "y"})
                  </span>
                </p>
              </div>

              {role === "admin" ? (
                <div className="px-3 py-2 rounded-xl bg-amber-100 text-amber-800 font-medium">
                  Admin nepotrebuje tokeny – klienti volajú tebe.
                </div>
              ) : (
                <button
                  onClick={fetchBalance}
                  className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700 transition"
                >
                  Obnoviť zostatok
                </button>
              )}
            </div>
          </section>

          {role !== "admin" && (
            <section className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
              {packs.map((p) => {
                const minutes = p.tokens * 60;
                return (
                  <div
                    key={p.id}
                    className="rounded-2xl bg-white/80 backdrop-blur shadow-sm border border-stone-200 p-5 flex flex-col"
                  >
                    <div className="flex items-center justify-between">
                      <h3 className="text-lg font-semibold">{p.label}</h3>
                      {p.note && (
                        <span className="text-xs px-2 py-1 rounded-full bg-emerald-100 text-emerald-800">
                          {p.note}
                        </span>
                      )}
                    </div>

                    <p className="text-stone-600 mt-1">
                      {p.tokens} token{p.tokens === 1 ? "" : "y"} • {formatMinutes(minutes)}
                    </p>

                    <div className="mt-4">
                      {p.strikeEur ? (
                        <div className="flex items-baseline gap-2">
                          <span className="text-stone-400 line-through">{p.strikeEur.toFixed(2)} €</span>
                          <span className="text-2xl font-semibold">{p.priceEur.toFixed(2)} €</span>
                        </div>
                      ) : (
                        <span className="text-2xl font-semibold">{p.priceEur.toFixed(2)} €</span>
                      )}
                    </div>

                    <button
                      onClick={() => handleBuy(p)}
                      className="mt-5 px-4 py-2 rounded-xl bg-amber-500 text-white shadow hover:bg-amber-600 transition"
                    >
                      Kúpiť
                    </button>

                    <p className="text-xs text-stone-500 mt-3">
                      Po nákupe sa zostatok automaticky navýši o {minutes} min ({p.tokens} token{p.tokens === 1 ? "" : "y"}).
                    </p>
                  </div>
                );
              })}
            </section>
          )}

          <p className="text-xs text-stone-500 mt-6">
            Tip: Token = kredit na hovor. Minúty sa odpočítavajú len počas aktívneho hovoru.
          </p>
        </SignedIn>
      </div>
    </main>
  );
}
