"use client";

import { SignedIn, SignedOut, SignInButton, useUser, useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";

type FridayToken = {
  id: string;
  issuedYear: number;
  minutesRemaining: number;
  status: "active" | "spent" | "listed";
};

type FridayBalance = {
  userId: string;
  totalMinutes: number;
  tokens: FridayToken[];
};

type SupplyInfo = {
  year: number;
  priceEur: number;
  treasuryAvailable: number;
  totalMinted: number;
  totalSold: number;
};

type Listing = {
  id: string;
  tokenId: string;
  sellerId: string;
  priceEur: number;
  status: "open" | "sold" | "cancelled";
  createdAt: string;
  token: FridayToken;
};

export default function BurzaTokenovPage() {
  const { user, isSignedIn } = useUser();
  const { getToken } = useAuth();
  const role = (user?.publicMetadata.role as string) || "client";

  const backend = process.env.NEXT_PUBLIC_BACKEND_URL!;
  const currentYear = useMemo(() => new Date().getFullYear(), []);
  const [supply, setSupply] = useState<SupplyInfo | null>(null);

  const [balance, setBalance] = useState<FridayBalance | null>(null);
  const [qty, setQty] = useState<number>(1);
  const [listings, setListings] = useState<Listing[]>([]);
  const [listPrice, setListPrice] = useState<Record<string, string>>({});
  const [buyingId, setBuyingId] = useState<string | null>(null);


  const tokensActive = useMemo(
    () => (balance?.tokens || []).filter((t) => t.status === "active" && t.minutesRemaining > 0),
    [balance]
  );
  const tokensListed = useMemo(() => (balance?.tokens || []).filter((t) => t.status === "listed"), [balance]);

  // limit 20 ks / user / rok – rátame len držané (active + listed)
  const ownedThisYear = useMemo(
    () =>
      (balance?.tokens || []).filter(
        (t) => t.issuedYear === currentYear && (t.status === "active" || t.status === "listed")
      ).length,
    [balance, currentYear]
  );
  const maxCanBuy = Math.max(0, 20 - ownedThisYear);

  const fetchSupply = useCallback(async () => {
    const res = await fetch(`${backend}/friday/supply?year=${currentYear}`);
    const data = (await res.json()) as SupplyInfo;
    setSupply(data);
  }, [backend, currentYear]);

  const fetchBalance = useCallback(async () => {
    if (!user) return;
    const res = await fetch(`${backend}/friday/balance/${user.id}`);
    const data = (await res.json()) as FridayBalance;
    setBalance(data);
  }, [backend, user]);

  const fetchListings = useCallback(async () => {
    const res = await fetch(`${backend}/friday/listings?take=50`);
    const data = await res.json();
    setListings(data?.items || []);
  }, [backend]);

  useEffect(() => {
    fetchSupply();
    fetchListings();
    if (isSignedIn) fetchBalance();
  }, [isSignedIn, fetchSupply, fetchBalance, fetchListings]);

  // Helper: auth headers pre admin volania
  const authHeaders = useCallback(async () => {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await getToken()}`,
    };
  }, [getToken]);

  const handlePrimaryBuy = useCallback(async () => {
    if (!user) return;
    if (!supply) return;

    const q = Number.isFinite(qty) && qty > 0 ? qty : 1;

    if (q > maxCanBuy) {
      alert(`Maximálne môžeš dokúpiť ešte ${maxCanBuy} tokenov pre rok ${currentYear}.`);
      return;
    }
    if (q > (supply.treasuryAvailable ?? 0)) {
      alert("Nie je dostatok tokenov v pokladnici.");
      return;
    }

    const res = await fetch(`${backend}/friday/purchase`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, quantity: q, year: currentYear }),
    });
    const data = await res.json();
    if (res.ok && data?.success) {
      alert(`Zakúpené ${q} token${q === 1 ? "" : "y"} za ${Number(data.unitPrice).toFixed(2)} €/ks ✅`);
      await Promise.all([fetchBalance(), fetchSupply()]);
    } else {
      alert(data?.message || "Nákup zlyhal.");
    }
  }, [backend, user, qty, maxCanBuy, currentYear, fetchBalance, fetchSupply, supply]);


  const handleBuyListing = useCallback(async (listingId: string) => {
  if (!user) return;
  try {
    setBuyingId(listingId);
    const res = await fetch(`${backend}/friday/buy-listing`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Ak budeš kontrolovať token na BE, odkomentuj:
        // Authorization: `Bearer ${await getToken()}`,
      },
      body: JSON.stringify({ buyerId: user.id, listingId }),
    });
    const data = await res.json();
    if (res.ok && data?.success) {
      alert(`Kúpený token ${data.tokenId.slice(0,8)}… za ${Number(data.priceEur).toFixed(2)} € ✅`);
      await Promise.all([fetchBalance(), fetchListings()]);
    } else {
      alert(data?.message || "Kúpa zlyhala.");
    }
  } finally {
    setBuyingId(null);
  }
}, [backend, user, fetchBalance, fetchListings /*, getToken*/]);

  const handleListToken = useCallback(
    async (tokenId: string) => {
      if (!user) return;
      const priceStr = listPrice[tokenId];
      const price = Number((priceStr || "").replace(",", "."));
      if (!Number.isFinite(price) || price <= 0) {
        alert("Zadaj cenu v €.");
        return;
      }
      const res = await fetch(`${backend}/friday/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerId: user.id, tokenId, priceEur: price }),
      });
      const data = await res.json();
      if (res.ok && data?.success) {
        alert("Token zalistovaný ✅");
        setListPrice((s) => ({ ...s, [tokenId]: "" }));
        await Promise.all([fetchBalance(), fetchListings()]);
      } else {
        alert(data?.message || "Zalistovanie zlyhalo.");
      }
    },
    [backend, user, listPrice, fetchBalance, fetchListings]
  );

  const handleCancelListing = useCallback(
    async (listingId: string) => {
      if (!user) return;
      const res = await fetch(`${backend}/friday/cancel-listing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerId: user.id, listingId }),
      });
      const data = await res.json();
      if (res.ok && data?.success) {
        await Promise.all([fetchBalance(), fetchListings()]);
      } else {
        alert(data?.message || "Zrušenie zlyhalo.");
      }
    },
    [backend, user, fetchBalance, fetchListings]
  );

  // POZOR: backend aktuálne NEMÁ /friday/buy-listing → nekupujeme z FE
  // Ak doplníš endpoint, ľahko to aktivuješ späť.

  const handleAdminMint = useCallback(async () => {
    if (role !== "admin") return;
    const qtyStr = prompt("Koľko tokenov chceš vytvoriť?");
    const priceStr = prompt("Za akú cenu (€) ich chceš ponúknuť?");
    const yearStr = prompt(`Pre aký rok? (default ${currentYear})`) || `${currentYear}`;
    const q = Number(qtyStr);
    const price = Number((priceStr || "").replace(",", "."));
    const year = Number(yearStr);

    if (!Number.isInteger(q) || q <= 0 || !Number.isFinite(price) || price <= 0 || !Number.isInteger(year)) {
      alert("Neplatné vstupy.");
      return;
    }

    const res = await fetch(`${backend}/friday/admin/mint`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ quantity: q, priceEur: price, year }),
    });
    const data = await res.json();
    if (res.ok && data?.success) {
      alert(`Vytvorených ${q} tokenov pre rok ${year} @ ${price.toFixed(2)} €`);
      await fetchSupply();
    } else {
      alert(data?.message || "Mint zlyhal.");
    }
  }, [backend, role, currentYear, fetchSupply, authHeaders]);

  const handleAdminSetPrice = useCallback(async () => {
    if (role !== "admin") return;
    const priceStr = prompt("Nová cena v pokladnici (€):");
    const price = Number((priceStr || "").replace(",", "."));
    if (!Number.isFinite(price) || price <= 0) {
      alert("Neplatná cena.");
      return;
    }

    const res = await fetch(`${backend}/friday/admin/set-price`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ newPrice: price, repriceTreasury: false }),
    });
    const data = await res.json();
    if (res.ok && data?.success) {
      alert(`Cena nastavená na ${price.toFixed(2)} €`);
      await fetchSupply();
    } else {
      alert(data?.message || "Zmena ceny zlyhala.");
    }
  }, [backend, role, fetchSupply, authHeaders]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-100 via-emerald-50 to-amber-50 text-stone-800">
      <div className="max-w-5xl mx-auto p-6">
        <header className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-emerald-600/10 flex items-center justify-center shadow-inner">
              <span className="text-emerald-700 font-bold">🪙</span>
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Burza piatkových tokenov</h1>
              <p className="text-sm text-stone-600">1 token = 60 min (len piatok)</p>
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
                  Piatkové minúty: <span className="font-semibold">{balance?.totalMinutes ?? 0} min</span>
                </p>
              </div>

              {role === "admin" ? (
                <div className="px-3 py-2 rounded-xl bg-amber-100 text-amber-800 font-medium">
                  Admin nepotrebuje tokeny – klienti volajú tebe.
                </div>
              ) : (
                <button
                  onClick={() => {
                    fetchBalance();
                    fetchListings();
                    fetchSupply();
                  }}
                  className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700 transition"
                >
                  Obnoviť dáta
                </button>
              )}
            </div>
          </section>

         {role === "admin" && (
  <section className="rounded-2xl bg-white/80 backdrop-blur shadow-sm border border-stone-200 p-5 mb-6">
    <h2 className="text-lg font-semibold">Admin – pokladnica</h2>
    <p className="text-sm text-stone-600 mt-1">
      Aktuálna cena: <span className="font-semibold">{supply ? supply.priceEur.toFixed(2) : "…"} €</span> •
      V pokladnici: <span className="font-semibold">{supply?.treasuryAvailable ?? 0}</span> tokenov (rok {currentYear})
    </p>

    {/* Mintovanie */}
    <div className="mt-4 flex flex-col gap-3 max-w-sm">
      <input
        type="number"
        min={1}
        value={qty}
        onChange={(e) => setQty(parseInt(e.target.value || "1", 10))}
        className="w-full px-3 py-2 rounded-xl border border-stone-300 bg-white"
        placeholder="Počet tokenov"
      />
      <input
        type="number"
        min={1}
        step="0.01"
        value={supply?.priceEur ?? ""}
        onChange={(e) =>
          setSupply((s) =>
            s
              ? { ...s, priceEur: parseFloat(e.target.value || "0") }
              : {
                  year: currentYear,
                  priceEur: parseFloat(e.target.value || "0"),
                  treasuryAvailable: 0,
                  totalMinted: 0,
                  totalSold: 0,
                }
          )
        }
        className="w-full px-3 py-2 rounded-xl border border-stone-300 bg-white"
        placeholder="Cena za token (€)"
      />

      <button
        onClick={async () => {
          const q = Number(qty);
          const price = Number(supply?.priceEur);
          if (!Number.isInteger(q) || q <= 0 || !Number.isFinite(price) || price <= 0) {
            alert("Zadaj platný počet a cenu.");
            return;
          }

          const res = await fetch(`${backend}/friday/admin/mint`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ quantity: q, priceEur: price }),
          });
          const data = await res.json();
          if (res.ok && data?.success) {
            alert(`Vytvorených ${q} tokenov pre rok ${currentYear} @ ${price.toFixed(2)} € ✅`);
            await fetchSupply();
          } else {
            alert(data?.message || "Mint zlyhal.");
          }
        }}
        className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700 transition"
      >
        Vygenerovať tokeny
      </button>
    </div>

    {/* NOVÝ BLOK: Zmeniť cenu */}
    <div className="mt-6 flex flex-col gap-3 max-w-sm">
      <input
        type="number"
        min={1}
        step="0.01"
        placeholder="Nová cena (€)"
        onChange={(e) => setListPrice((s) => ({ ...s, newPrice: e.target.value }))}
        value={listPrice["newPrice"] ?? ""}
        className="w-full px-3 py-2 rounded-xl border border-stone-300 bg-white"
      />
      <button
        onClick={async () => {
          const price = Number((listPrice["newPrice"] || "").replace(",", "."));
          if (!Number.isFinite(price) || price <= 0) {
            alert("Zadaj platnú cenu.");
            return;
          }

          const res = await fetch(`${backend}/friday/admin/set-price`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ newPrice: price, repriceTreasury: false }),
          });
          const data = await res.json();
          if (res.ok && data?.success) {
            alert(`Cena tokenov bola nastavená na ${price.toFixed(2)} € ✅`);
            setListPrice((s) => ({ ...s, newPrice: "" }));
            await fetchSupply();
          } else {
            alert(data?.message || "Zmena ceny zlyhala.");
          }
        }}
        className="px-4 py-2 rounded-xl bg-green-600 text-white shadow hover:bg-green-700 transition"
      >
        Zmeniť cenu
      </button>
    </div>

    <div className="mt-4 flex flex-wrap gap-3">
      <button
        onClick={() => {
          fetchSupply();
          fetchListings();
        }}
        className="px-4 py-2 rounded-xl bg-stone-700 text-white shadow hover:bg-stone-800 transition"
      >
        Obnoviť
      </button>
    </div>
  </section>
)}


          {role !== "admin" && (
            <>
              {/* Primárny nákup */}
              <section className="rounded-2xl bg-white/80 backdrop-blur shadow-sm border border-stone-200 p-5 mb-6">
                <h2 className="text-lg font-semibold">Primárny nákup (pokladnica)</h2>
                <p className="text-sm text-stone-600 mt-1">
                  Rok {currentYear} • Cena:{" "}
                  <span className="font-semibold">{supply ? supply.priceEur.toFixed(2) : "…"} €</span>/token •
                  Dostupných v pokladnici: <span className="font-semibold">{supply?.treasuryAvailable ?? 0}</span>
                </p>
                <p className="text-xs text-stone-500 mt-1">
                  Limit: max 20 tokenov/rok/osoba. Aktuálne držíš {ownedThisYear} tokenov z {currentYear}.
                </p>

                <div className="mt-4 flex items-center gap-3">
                  <input
                    type="number"
                    min={1}
                    max={Math.min(maxCanBuy, supply?.treasuryAvailable ?? 0)}
                    value={qty}
                    onChange={(e) => setQty(parseInt(e.target.value || "1", 10))}
                    className="w-24 px-3 py-2 rounded-xl border border-stone-300 bg-white"
                  />
                  <button
                    onClick={handlePrimaryBuy}
                    className="px-4 py-2 rounded-xl bg-amber-500 text-white shadow hover:bg-amber-600 transition"
                    disabled={role === "admin" || !supply || (supply?.treasuryAvailable ?? 0) <= 0 || maxCanBuy <= 0}
                  >
                    Kúpiť tokeny
                  </button>
                </div>
              </section>

              {/* Moje tokeny */}
              <section className="rounded-2xl bg-white/80 backdrop-blur shadow-sm border border-stone-200 p-5 mb-6">
                <h2 className="text-lg font-semibold">Moje tokeny</h2>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 mt-4">
                  {(balance?.tokens || []).map((t) => (
                    <div key={t.id} className="rounded-xl border border-stone-200 bg-white p-4">
                      <div className="flex items-center justify-between">
                        <div className="font-medium">Rok {t.issuedYear}</div>
                        <div
                          className={`text-xs px-2 py-1 rounded-full ${
                            t.status === "active"
                              ? "bg-emerald-100 text-emerald-800"
                              : t.status === "listed"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-stone-200 text-stone-700"
                          }`}
                        >
                          {t.status}
                        </div>
                      </div>
                      <div className="text-sm text-stone-600 mt-2">Zostatok: {t.minutesRemaining} min</div>

                      {t.status === "active" && t.minutesRemaining > 0 && (
                        <div className="mt-3 flex items-center gap-2">
                          <input
                            placeholder="Cena €"
                            value={listPrice[t.id] ?? ""}
                            onChange={(e) => setListPrice((s) => ({ ...s, [t.id]: e.target.value }))}
                            className="flex-1 px-3 py-2 rounded-xl border border-stone-300 bg-white"
                          />
                          <button
                            className="px-3 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700 transition"
                            onClick={() => handleListToken(t.id)}
                          >
                            Zalistovať
                          </button>
                        </div>
                      )}
                      {t.status === "listed" && (
                        <div className="mt-3 text-xs text-stone-500">Token je na burze (možno zrušiť nižšie).</div>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              {/* Burza */}
              <section className="rounded-2xl bg-white/80 backdrop-blur shadow-sm border border-stone-200 p-5">
                <h2 className="text-lg font-semibold">Burza</h2>
                {listings.length === 0 ? (
                  <p className="text-sm text-stone-600 mt-2">Žiadne otvorené ponuky.</p>
                ) : (
                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    {listings.map((l) => (
                      <div key={l.id} className="rounded-xl border border-stone-200 bg-white p-4 flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                          <div className="font-medium">
                            Token {l.token.issuedYear}, {l.token.minutesRemaining} min
                          </div>
                          <div className="text-stone-600">{Number(l.priceEur).toFixed(2)} €</div>
                        </div>
                        <div className="text-xs text-stone-500">ID: {l.id.slice(0, 8)}…</div>
                        <div className="flex items-center gap-2 mt-2">
                          <button
                            onClick={() => handleBuyListing(l.id)}
                            disabled={role === "admin" || user?.id === l.sellerId || buyingId === l.id}
                            className={`px-4 py-2 rounded-xl text-white shadow transition
                              ${role === "admin" || user?.id === l.sellerId
                                ? "bg-stone-400 cursor-not-allowed"
                                : buyingId === l.id
                                  ? "bg-amber-400"
                                  : "bg-amber-500 hover:bg-amber-600"}`}
                            title={user?.id === l.sellerId ? "Nemôžeš kúpiť vlastný listing" : ""}
                          >
                            {buyingId === l.id ? "Kupujem…" : "Kúpiť"}
                          </button>

                          {user?.id === l.sellerId && (
                            <button
                              className="px-4 py-2 rounded-xl bg-stone-700 text-white shadow hover:bg-stone-800 transition"
                              onClick={() => handleCancelListing(l.id)}
                            >
                              Zrušiť listing
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}

          <p className="text-xs text-stone-500 mt-6">
            Token = právo na 60 min v piatok. Nevyužité tokeny sa prenášajú do ďalšieho roka.
          </p>
        </SignedIn>
      </div>
    </main>
  );
}
