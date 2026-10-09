# MADNI LPG POS — Socket.IO setup (Roman Urdu)

## Kya add hua hai?

- HTML ab Socket.IO client ko zaroorat par load karta hai.
- Sale/purchase/customer ya doosri cloud changes successful Cloudflare Worker commit ke **baad** `cloud:announce` signal bhejti hain.
- Doosre device ko signal milte hi woh apne authenticated Cloudflare Worker se latest changes pull karta hai.
- Socket.IO server par invoice, customer, balance, password ya accounting records store/relay nahi hote; sirf tenant-scoped wake-up signal jata hai.
- Internet ya Socket.IO band ho to original polling fallback chalti rehti hai. Is liye Socket.IO deploy na hone par bhi purana sync transport fallback mode mein rahega.

## Step 1 — ZIP extract karein

Is folder ke files GitHub repository mein upload karne hain: `server.js`, `package.json`, `.env.example`, `README_ROMAN_URDU.md`. `.env.example` reference hai; Render par values Environment section mein daalni hain. `.env` mein koi password/token save na karein.

## Step 2 — GitHub repository banayein

1. GitHub par sign in karein.
2. `New repository` par click karein.
3. Repository ka naam `madni-lpg-socketio-sync` rakh dein.
4. Private repository behtar hai.
5. `server.js` aur `package.json` root folder mein upload/commit karein. `.env.example` bhi upload kar sakte hain.

## Step 3 — Render par service deploy karein

1. https://render.com/ par sign in karein.
2. `New` → `Web Service` choose karein aur apni GitHub repository connect karein.
3. Runtime `Node` select karein.
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Node runtime 20 ya us se naya use karein.
7. Service create/deploy karein.

## Step 4 — Render Environment variables set karein

Render dashboard → apni service → `Environment` → `Add Environment Variable`:

- `MADNI_WORKER_URL` = `https://madni-lpg-api.nebulaelectronicsshop.workers.dev`
- `ALLOWED_ORIGINS` = `null,http://localhost:3000,https://YOUR-POS-WEBSITE.example`
- `ALLOW_CLIENT_TENANT_CLAIM` = `false`

`https://YOUR-POS-WEBSITE.example` ko apni asal hosted POS website origin se replace karein. Agar HTML sirf computer par `file://` se test kar rahe hain to `null` ko temporary rakhein. Production mein agar app hosted ho to uska exact `https://...` origin add karein. Changes save karke redeploy karein.

## Step 5 — Server health check

Render dashboard mein service ka public URL copy karein, misal ke taur par `https://madni-lpg-socketio.onrender.com`.

Browser mein ye URL kholein:

`https://YOUR-SOCKET-SERVICE.onrender.com/health`

Expected JSON mein `"ok": true` aur `"socketIo": true` hona chahiye. Agar 404/error aaye to Render ke `Logs` tab mein deploy error dekhein.

## Step 6 — HTML mein Socket.IO server URL paste karein

`MADNI_LPG_POS_V10_SOCKETIO_READY.html` ko Notepad ya VS Code mein kholein. Search karein:

`const MADNI_SOCKET_SERVER_URL = 'https://CHANGE-ME.onrender.com';`

`CHANGE-ME` ko Step 5 par mili Render URL se replace karein, example:

`const MADNI_SOCKET_SERVER_URL = 'https://madni-lpg-socketio.onrender.com';`

URL ke end par `/` na lagayein. File save karein. Ab isi updated HTML ko open/host karein—purani copy open karne se Socket.IO activate nahi hoga.

## Step 7 — Worker authentication tenant check

Socket.IO server pehle aapke existing Cloudflare Worker ke `POST /auth/verify` endpoint se token validate karta hai; zaroorat par `/rpc/madni_shop_context` aur tenant-scoped `/sync/pull` response bhi check karta hai. Security ke liye worker response se authenticated `shop_owner_id` milna chahiye aur woh HTML ke `shopOwnerId` ke barabar hona chahiye.

Agar Render logs mein ye error aaye:

`Worker authentication succeeded but did not return shop_owner_id...`

To current Worker ka `/auth/verify` route valid token ke associated account se `shop_owner_id` response mein include karein, misal ke taur par `{ "ok": true, "shop_owner_id": "<authenticated shop owner id>" }`. Actual variable/database field naam aapke Worker source ke mutabiq hoga. Worker source file is bundle mein nahi thi, is liye us route ka code yahan safely edit nahi kiya ja sakta. `ALLOW_CLIENT_TENANT_CLAIM=true` ko permanent solution na banayein; woh weaker fallback hai aur default se band hai.

## Step 8 — Laptop aur mobile test karein

1. Laptop aur mobile dono par updated HTML open karein.
2. Dono par **same Cloud email/password aur same shop** se sign in karein.
3. Laptop par test customer add/save karein.
4. Mobile par 1–2 seconds ke andar customer appear hona chahiye, refresh ke baghair. Phir mobile par doosra customer add karke laptop par verify karein.
5. Browser DevTools → Console kholein aur command chalayein:

```js
window.MADNI_SYNC_STATUS()
```

Expected fields: `socketConfigured: true`, `socketConnected: true`, `transport: "socket.io"`; `pendingQueue` normal sync ke baad `0` hona chahiye.

## Troubleshooting

- `socketConfigured: false`: HTML mein URL abhi `CHANGE-ME` hai ya URL `https://` se shuru nahi hota.
- `socketConnected: false`: Render service URL, Allowed Origins, Worker authentication aur Render logs check karein.
- CORS/origin error: `ALLOWED_ORIGINS` mein POS origin exact match hona chahiye; protocol (`https://`), subdomain aur port bhi matter karte hain.
- `shop_owner_id` missing: Worker `/auth/verify` ko authenticated owner ID return karna hoga (Step 7).
- `pendingQueue` barhta rahe: ye Socket.IO ka masla zaroori nahi; Cloudflare Worker `madni_commit_batch`/conflict/auth error bhi ho sakta hai. Console aur Render/Worker logs check karein.
- App background mein suspend ho: mobile browser tab ko foreground mein laane par app catch-up pull karti hai; browser background restrictions ki wajah se device asleep ho to instant update guarantee nahi ki ja sakti.

## Important limitation

Socket.IO live notification deta hai; woh khud data database ya multi-device merge engine nahi hai. Durable data, access control, version/conflict handling aur final accounting writes existing Cloudflare Worker hi karta hai. Is patch se Socket.IO server deploy ho sakta hai, lekin yahan se aapke Render/Cloudflare accounts mein login karke deployment ya live two-device test nahi kiya gaya.
