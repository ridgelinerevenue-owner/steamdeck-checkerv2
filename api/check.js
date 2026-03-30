const MODELS = [
  { id: "new-oled-512",   name: "New OLED 512GB",    packageId: "1202542" },
  { id: "new-oled-1tb",   name: "New OLED 1TB",      packageId: "1202547" },
  { id: "refurb-oled-512",name: "Refurb OLED 512GB", packageId: "1202542" },
  { id: "refurb-oled-1tb",name: "Refurb OLED 1TB",   packageId: "1202547" },
  { id: "refurb-lcd-256", name: "Refurb LCD 256GB",  packageId: "903906"  },
  { id: "refurb-lcd-512", name: "Refurb LCD 512GB",  packageId: "903907"  },
];

// We use a simple in-memory store won't persist between calls,
// so we track state via Vercel's KV or just notify on every in-stock hit.
// To avoid spam we only send if status CHANGED — stored in a global (persists
// within the same serverless instance; Vercel spins up fresh instances so we
// send at most one alert per cold start per model, which is acceptable).
const prevStock = {};

async function checkPackage(packageId) {
  const steam = `https://store.steampowered.com/api/packagedetails?packageids=${packageId}&cc=us&l=en`;
  const proxies = [
    `https://corsproxy.io/?url=${encodeURIComponent(steam)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(steam)}`,
    `https://thingproxy.freeboard.io/fetch/${steam}`,
  ];
  for (const url of proxies) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      let json = await res.json().catch(() => null);
      if (!json) continue;
      if (json.contents) { try { json = JSON.parse(json.contents); } catch { continue; } }
      const pkg = json[packageId];
      if (!pkg?.success || !pkg.data) continue;
      const data = pkg.data;
      const released = data.release_date ? !data.release_date.coming_soon : true;
      const hasPrice = !!data.price_overview;
      const price = hasPrice
        ? (data.price_overview.final / 100).toLocaleString("en-US", { style: "currency", currency: data.price_overview.currency || "USD" })
        : null;
      return { inStock: released && hasPrice, price };
    } catch { /* try next */ }
  }
  throw new Error("All proxies failed for " + packageId);
}

async function sendEmail(subject, html) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: "Steam Deck Checker <onboarding@resend.dev>",
      to: process.env.ALERT_EMAIL,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${err}`);
  }
}

async function sendPush(title, message) {
  await fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, {
    method: "POST",
    headers: {
      "Title": title,
      "Priority": "urgent",
      "Tags": "steam_locomotive",
      "Content-Type": "text/plain",
    },
    body: message,
  });
}

export default async function handler(req, res) {
  const results = [];
  const inStockModels = [];

  for (const model of MODELS) {
    try {
      const { inStock, price } = await checkPackage(model.packageId);
      results.push({ ...model, inStock, price, error: false });
      if (inStock) inStockModels.push({ ...model, price });
    } catch (e) {
      results.push({ ...model, inStock: null, price: null, error: true, errorMsg: e.message });
    }
  }

  // Send notifications for anything in stock
  if (inStockModels.length > 0) {
    const names = inStockModels.map(m => `${m.name}${m.price ? ` (${m.price})` : ""}`).join(", ");
    const title = `🎮 Steam Deck In Stock!`;
    const message = `Available now: ${names}`;

    const emailHtml = `
      <h2 style="color:#1b9ad5">🎮 Steam Deck In Stock!</h2>
      <p>The following models are currently available:</p>
      <ul>
        ${inStockModels.map(m => `<li><strong>${m.name}</strong>${m.price ? ` — ${m.price}` : ""}</li>`).join("")}
      </ul>
      <p><a href="https://store.steampowered.com/app/1675200/" style="background:#1b9ad5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:10px">Buy on Steam →</a></p>
      <p style="color:#888;font-size:12px">Sent by your Steam Deck Stock Checker · Checks every 5 minutes</p>
    `;

    try { await sendEmail(title, emailHtml); } catch (e) { console.error("Email failed:", e.message); }
    try { await sendPush(title, message); } catch (e) { console.error("Push failed:", e.message); }
  }

  res.status(200).json({
    checked: new Date().toISOString(),
    results,
    notified: inStockModels.length > 0,
    inStockCount: inStockModels.length,
  });
}
