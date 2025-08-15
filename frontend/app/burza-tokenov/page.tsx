"use client";

import { SignedIn, SignedOut, SignInButton, useUser } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";

type FridayToken = {
  id: string;
  minutesRemaining: number;
  status: "active" | "spent" | "listed";
};

type FridayBalance = {
  userId: string;
  totalMinutes: number;
  tokens: FridayToken[];
};

type SupplyInfo = {
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
  const role = (user?.publicMetadata.role as string) || "client";

  const backend = process.env.NEXT_PUBLIC_BACKEND_URL!;
  const [supply, setSupply] = useState<SupplyInfo | null>(null);

  const [balance, setBalance] = useState<FridayBalance | null>(null);
  const [qty, setQty] = useState<number>(1); // primary purchase quantity
  const [listings, setListings] = useState<Listing[]>([]);
  const [listPrice, setListPrice] = useState<Record<string, string>>({}); // tokenId -> price input

  const [mintQty, setMintQty] = useState<number>(100);
  const [mintPrice, setMintPrice] = useState<string>("400");
  const [newPrice, setNewPrice] = useState<string>("");

  const MAX_PER_USER = 20;

  const tokensActive = useMemo(
    () => (balance?.tokens || []).filter((t) => t.status === "active" && t.minutesRemaining > 0),
    [balance]
  );
  const tokensListed = useMemo(() => (balance?.tokens || []).filter((t) => t.status === "listed"), [balance]);

  const ownedActive = tokensActive.length;
  const maxCanBuy = Math.max(
    0,
    Math.min(MAX_PER_USER - ownedActive, supply?.treasuryAvailable ?? 0)
  );

  const fetchSupply = useCallback(async () => {
    const res = await fetch(`${backend}/friday/supply`);
    if (!res.ok) return setSupply(null);
    const data = (await res.json()) as SupplyInfo;
    setSupply(data);
  }, [backend]);

  const fetchBalance = useCallback(async () => {
    if (!user) return;
    const res = await fetch(`${backend}/friday/balance/${user.id}`);
    if (!res.ok) return setBalance(null);
    const data = (await res.json()) as FridayBalance;
    setBalance(data);
  }, [backend, user]);

  const fetchListings = useCallback(async () => {
    const res = await fetch(`${backend}/friday/listings?take=50`);
    if (!res.ok) return setListings([]);
    const data = await res.json();
    setListings(data?.items || []);
  }, [backend]);

  useEffect(() => {
    fetchSupply();
    fetchListings();
    if (isSignedIn) fetchBalance();
  }, [isSignedIn, fetchSupply, fetchBalance, fetchListings]);

  const handlePrimaryBuy = useCallback(async () => {
    if (!user || !supply) return;
    if (qty <= 0) return;
    if (qty > maxCanBuy) {
      alert(`Maximálne môžeš dokúpiť ešte ${maxCanBuy} tokenov.`);
      return;
    }
    if (qty > (supply.treasuryAvailable ?? 0)) {
      alert("Nie je dostatok tokenov v pokladnici.");
      return;
    }

    const res = await fetch(`${backend}/friday/purchase`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, quantity: qty }),
    });
    const data = await res.json();
    if (res.ok && data?.success) {
      const up = typeof data.unitPrice === "number" ? data.unitPrice : Number(data.unitPrice);
      alert(`Zakúpené ${qty} token${qty === 1 ? "" : "y"} za ${up.toFixed(2)} €/ks ✅`);
      await Promise.all([fetchBalance(), fetchSupply()]);
    } else {
      alert(data?.message || "Nákup zlyhal.");
    }
  }, [backend, user, qty, maxCanBuy, fetchBalance, fetchSupply, supply]);

  const handleAdminMint = useCallback(async () => {
    if (role !== "admin") return;
    const quantity = Number(mintQty);
    const priceEur = Number(mintPrice);
    if (!quantity || quantity <= 0 || !priceEur || priceEur <= 0) {
      alert("Vyplň počet a cenu (> 0).");
      return;
    }
    const res = await fetch(`${backend}/friday/admin/mint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adminId: process.env.NEXT_PUBLIC_ADMIN_ID,
        quantity,
        priceEur,
      }),
    });
    const data = await res.json();
    if (res.ok && data?.success) {
      const p = typeof priceEur === "number" ? priceEur : Number(priceEur);
      alert(`Vygenerovaných ${quantity} tokenov za ${p.toFixed(2)} €/ks ✅`);
      await fetchSupply();
    } else {
      alert(data?.message || "Mint zlyhal.");
    }
  }, [role, backend, mintQty, mintPrice, fetchSupply]);

  const handleAdminUpdatePrice = useCallback(async () => {
    if (role !== "admin") return;
    const price = Number(newPrice);
    if (!price || price <= 0) {
      alert("Zadaj novú cenu v € (> 0).");
      return;
    }
    const res = await fetch(`${backend}/friday/admin/update-price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adminId: process.env.NEXT_PUBLIC_ADMIN_ID,
        newPriceEur: price,
      }),
    });
    const data = await res.json();
    if (res.ok && data?.success) {
      alert(`Cena upravená na ${price.toFixed(2)} € ✅`);
      setNewPrice("");
      await fetchSupply();
    } else {
      alert(data?.message || "Zmena ceny zlyhala.");
    }
  }, [role, backend, newPrice, fetchSupply]);

  const handleListToken = useCallback(
    async (tokenId: string) => {
      if (!user) return;
      const priceStr = listPrice[tokenId];
      const price = Number(priceStr);
      if (!price || price <= 0) {
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

  const handleBuyListing = useCallback(
    async (listingId: string) => {
      if (!user) return;
      const res = await fetch(`${backend}/friday/purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buyerId: user.id, listingId }),
      });
      const data = await res.json();
      if (res.ok && data?.success) {
        alert("Token kúpený ✅");
        await Promise.all([fetchBalance(), fetchListings()]);
      } else {
        alert(data?.message || "Kúpa zlyhala.");
      }
    },
    [backend, user, fetchBalance, fetchListings]
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
                Aktuálna cena:{" "}
                <span className="font-semibold">
                  {supply ? Number(supply.priceEur).toFixed(2) : "…"} €
                </span>
                /token • V pokladnici:{" "}
                <span className="font-semibold">{supply?.treasuryAvailable ?? 0}</span>
              </p>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {/* Mint + cena */}
                <div className="rounded-xl border border-stone-200 bg-white p-4">
                  <div className="font-medium mb-2">Vygenerovať tokeny</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      value={mintQty}
                      onChange={(e) => setMintQty(parseInt(e.target.value || "1", 10))}
                      className="w-28 px-3 py-2 rounded-xl border border-stone-300 bg-white"
                      placeholder="Počet"
                    />
                    <input
                      type="number"
                      min={1}
                      step="1"
                      value={mintPrice}
                      onChange={(e) => setMintPrice(e.target.value)}
                      className="w-32 px-3 py-2 rounded-xl border border-stone-300 bg-white"
                      placeholder="€ / token"
                    />
                    <button
                      onClick={handleAdminMint}
                      className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700 transition"
                    >
                      Generovať
                    </button>
                  </div>
                  <p className="text-xs text-stone-500 mt-2">
                    Vytvorí {mintQty} ks a nastaví cenu na {mintPrice} €/ks.
                  </p>
                </div>

                {/* Zmeniť cenu v pokladnici */}
                <div className="rounded-xl border border-stone-200 bg-white p-4">
                  <div className="font-medium mb-2">Zmeniť cenu (nepredané)</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      step="1"
                      value={newPrice}
                      onChange={(e) => setNewPrice(e.target.value)}
                      className="w-32 px-3 py-2 rounded-xl border border-stone-300 bg-white"
                      placeholder="Nová cena €"
                    />
                    <button
                      onClick={handleAdminUpdatePrice}
                      className="px-4 py-2 rounded-xl bg-amber-500 text-white shadow hover:bg-amber-600 transition"
                    >
                      Zmeniť sumu
                    </button>
                  </div>
                  <p className="text-xs text-stone-500 mt-2">
                    Ovplyvní iba primárnu cenu v pokladnici – už zakúpené tokeny a listingy ostávajú nezmenené.
                  </p>
                </div>
              </div>
            </section>
          )}

          {role !== "admin" && (
            <>
              {/* Primárny nákup */}
              <section className="rounded-2xl bg-white/80 backdrop-blur shadow-sm border border-stone-200 p-5 mb-6">
                <h2 className="text-lg font-semibold">Primárny nákup (pokladnica)</h2>
                <p className="text-sm text-stone-600 mt-1">
                  Cena:{" "}
                  <span className="font-semibold">
                    {supply ? Number(supply.priceEur).toFixed(2) : "…"} €
                  </span>
                  /token • Dostupných v pokladnici:{" "}
                  <span className="font-semibold">{supply?.treasuryAvailable ?? 0}</span>
                </p>

                <p className="text-xs text-stone-500 mt-1">
                  Limit: max {MAX_PER_USER} tokenov na osobu. Aktuálne držíš {ownedActive} tokenov.
                </p>

                <div className="mt-4 flex items-center gap-3">
                  <input
                    type="number"
                    min={1}
                    max={maxCanBuy}
                    value={qty}
                    onChange={(e) => setQty(parseInt(e.target.value || "1", 10))}
                    className="w-24 px-3 py-2 rounded-xl border border-stone-300 bg-white"
                  />
                  <button
                    onClick={handlePrimaryBuy}
                    className="px-4 py-2 rounded-xl bg-amber-500 text-white shadow hover:bg-amber-600 transition"
                    disabled={!supply || (supply?.treasuryAvailable ?? 0) <= 0 || maxCanBuy <= 0}
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
                        <div className="font-medium">Piatkový token</div>
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

              {/* Moje listované (zrušenie) */}
              {tokensListed.length > 0 && (
                <section className="rounded-2xl bg-white/80 backdrop-blur shadow-sm border border-stone-200 p-5 mb-6">
                  <h2 className="text-lg font-semibold">Moje zalistované tokeny</h2>
                  <div className="text-sm text-stone-600 mt-2">
                    Zrušenie nájdeš priamo v sekcii burza pri položke tvojho listingu.
                  </div>
                </section>
              )}

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
                          <div className="font-medium">Token • {l.token.minutesRemaining} min</div>
                          <div className="text-stone-600">{Number(l.priceEur).toFixed(2)} €</div>
                        </div>
                        <div className="text-xs text-stone-500">ID: {l.id.slice(0, 8)}…</div>
                        <div className="flex items-center gap-2 mt-2">
                          <button
                            className="px-4 py-2 rounded-xl bg-amber-500 text-white shadow hover:bg-amber-600 transition"
                            onClick={() => handleBuyListing(l.id)}
                          >
                            Kúpiť
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
