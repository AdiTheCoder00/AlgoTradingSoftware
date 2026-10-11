# Kinetix Algo — reproducing artifacts and running the servers

## 1. Reproducing the uncommitted artifacts a fresh checkout needs

1. **Dependencies** (Node 22+, npm workspaces rooted at the repo root):
   `npm install`
2. **Shared contracts must be built before the web app can resolve them** —
   `apps/web` imports `packages/shared/dist/*`:
   `npm run build:shared`
3. **Copy the env template and fill it in** (values live only in `.env`, which is
   untracked — never commit or paste them):
   `cp .env.example .env`
   For a Kotak-backed session set:
   - `MARKET_PROVIDER=kotakneo` and `EXECUTION_VENUE=kotakneo`
   - `KOTAK_NEO_CONSUMER_KEY` — the token from the Kotak Trade API dashboard
   - `KOTAK_NEO_MOBILE` — the mobile registered against that key/UCC, **including
     the `+91` country code** (a bare 10-digit number is rejected by Kotak, and so
     is a bare `91` prefix)
   - `KOTAK_NEO_UCC`, `KOTAK_NEO_MPIN`, `KOTAK_NEO_TOTP_SECRET`
   - `KOTAK_NEO_BASE_URL=https://mis.kotaksecurities.com` — this is the *session*
     host only; the per-account REST, market-feed and order-feed hosts are
     returned by `/login/1.0/tradeApiValidate` and cached for the session
   Leaving `MARKET_PROVIDER`/`EXECUTION_VENUE` at `simulated` runs everything on the
   deterministic simulator with no credentials.
4. **Database**: created, migrated and (configuration-)seeded on first boot at
   `apps/api/data/kinetix.db`. To start over:
   `npm run seed -w @kinetix/api -- --reset`
   This now seeds guardrail configuration only; there is no demo book, no sample
   positions and no sample bots.

## 2. Running the servers

Two processes. Both are started detached so they outlive the shell that launched
them — on Windows, `Start-Process` with the executable named exactly (`npm.cmd`),
and stdout and stderr going to **different** files:

```powershell
$repo = 'C:\Users\maini\OneDrive\Desktop\algo 2'

# API + engine on 8787. Also serves the built terminal from apps/web/dist.
Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','start','-w','@kinetix/api' `
  -WorkingDirectory $repo `
  -RedirectStandardOutput "$repo\.freebuff\preview-8de508db-api.log" `
  -RedirectStandardError  "$repo\.freebuff\preview-8de508db-api.log.err" `
  -WindowStyle Hidden -PassThru

# Vite dev server on 5173, proxying /api and /ws to 8787.
Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','dev','-w','@kinetix/web' `
  -WorkingDirectory $repo `
  -RedirectStandardOutput "$repo\.freebuff\preview-8de508db-2e2d-478f-b932-2aade209ee54.log" `
  -RedirectStandardError  "$repo\.freebuff\preview-8de508db-2e2d-478f-b932-2aade209ee54.log.err" `
  -WindowStyle Hidden -PassThru
```

Notes that cost real time to discover:

- **Do not capture the pid with `$(powershell …)` / a pipe.** The spawned server
  inherits the pipe handle, so the command substitution never returns and the whole
  invocation hangs. Redirect PowerShell's own output to a file and read it.
- **Ports**: 5173 is Vite's configured `strictPort`; 8787 comes from `PORT` in `.env`.
- `Start-Process` will not resolve shell shims — name `npm.cmd`, not `npm`.

## 3. Opening a live Kotak session

Sessions are held in memory by the API, so **log in again after every API restart**:

```bash
curl -X POST -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:8787/api/broker/kotakneo/login
```

The login body may be empty because the credentials, TOTP (generated from
`KOTAK_NEO_TOTP_SECRET`) and MPIN all come from `.env`. Useful read-only checks:

- `GET /api/broker/status` — session state, account host, missing env vars
- `GET /api/broker/kotakneo/instruments?q=RELIANCE` — scrip-master lookup (works
  without a session; authenticates with the consumer key alone)
- `GET /api/broker/kotakneo/quote?symbol=RELIANCE` — one live quote, end to end
- `GET /api/broker/kotakneo/positions | limits | orders` — the real account book

## 3b. Live NSE market data (Kotak-backed)

With a session open, the engine polls the resolved NSE watchlist every 3 seconds
and publishes real ticks on the *same* `market:<symbol>` channel the simulator
uses, so the terminal needs no second code path. Live instruments are namespaced
`NSE:RELIANCE` so they can never be confused with a simulated symbol that fills
against a simulated book.

- `GET /api/live/quotes` — resolved instruments, latest quotes, feed health
- `GET /api/live/<NSE:SYMBOL>/candles?timeframe=1m|15m|1h|1d` — bars aggregated
  from the collected 1-minute tape
- `POST /api/live/poll` — force a poll cycle (the terminal's “Poll now” button)
- `GET /api/live/positions` — routing mode, the local NSE paper book, resting
  paper limits, and (with a session) the positions held at Kotak itself
- `POST /api/live/routing` `{"mode":"paper"|"live"}` — arm/disarm live routing
- `POST /api/live/positions/<id>/close` — close a paper position, or a broker
  position (id `broker_<tradingSymbol>`) with an opposing live order

The watchlist is `DEFAULT_LIVE_WATCHLIST` in `apps/api/src/market/liveFeed.ts`.

**Bars persist.** They are written through a `kv`-backed store
(`apps/api/src/market/barStore.ts`, one row per symbol) as they accumulate and
restored on boot, so a restart resumes the tape instead of clearing the chart.
Boot logs the restoration (`[live] … restored N persisted bars`).

**Depth.** Kotak's `all` quote does carry five price levels a side under
`depth.buy[]` / `depth.sell[]` (`price`, `quantity`, `orders`) — verified against
the live payload. Outside market hours every level is `0`, so nothing is
published; during the session the feed builds a book and broadcasts it on the
same `book:<symbol>` channel the simulator uses. No ladder is ever synthesised.

**Order routing** (`apps/api/src/market/liveTrading.ts`) — the NSE ticket has two
destinations and paper is the default:

- `paper` — fills at the live quote and books into the local NSE book, held in
  the `positions` table under the `kotakneo` venue. The simulated portfolio
  filters that venue out on purpose, so rupee P&L never touches the USD equity,
  drawdown or 30-day record.
- `live` — forwarded to Kotak with the resolved token/trading symbol. Requires a
  connected session, is never implicit, and is armed either per request
  (`routing` on `POST /api/orders`) or via `POST /api/live/routing`. Live orders
  are recorded as `working` with the broker's order id, and cancels go to Kotak
  through the adapter.

Live routing is opt-in state in the `kv` table: it survives a restart, so
**check `GET /api/live/positions` before assuming orders are paper**.

**Reconciliation** (`reconcile()` in the same module; scheduled every 20 seconds
in `server.ts`, and runnable on demand with `POST /api/live/reconcile`). Kotak
accepts orders asynchronously, so the local record of an order is only a claim
about it until the venue's own book is read:

- **Orders** — `/quick/user/orders` is normalised by `mapOrderState` (status
  vocabulary, filled quantity, average price, rejection reason) and every local
  live order with a broker id is updated from it. A status the adapter does not
  recognise leaves the order untouched rather than inventing a state, and a row
  without an order number is not an order at all — which is exactly what an empty
  book (`{ stCode, errMsg, desc, stat }`) returns.
- **Fills** — a filled quantity the venue reports that the local row has not yet
  booked becomes a `fills` row plus a mirrored position. A given delta is booked
  once, so repeated passes over the same book are idempotent.
- **Positions** — the venue's position book is mirrored into `positions` under
  the `broker` pseudo-strategy (id `broker_<tradingSymbol>`), marked from the live
  feed and closable from the terminal like any other live position. A mirror is
  only dropped after the venue has reported no such position **twice** in a row,
  because a position book that has not settled yet is normal — and a mirror
  created by a fill in the same pass is never dropped by it.
- `GET /api/live/positions` prefers the venue's own book while it answers, and
  falls back to the mirrors when the broker call fails, so a broker blip does not
  blank the panel.

The account has no live orders at the time of writing, so the fill path is
covered by tests against a stubbed venue. Against the real account, both the
scheduled passes and `POST /api/live/reconcile` were verified to return cleanly —
in particular without materialising a phantom order from an empty order book.

Still deliberate limits, none of which are bugs to “fix” by inventing data:

- Bars only exist from the first poll onwards (persisted across restarts); Kotak's
  REST surface here exposes no historical candles, so a *fresh database* still
  starts with an empty chart and the endpoint returns a `note` saying so.
- Equities only. Kotak rejects index tokens (`nse_cm|26000`) on the quote
  endpoint, so NIFTY/BANKNIFTY are dropped rather than quoted as something else.
- Live *paper* fills pay the quoted touch (slippage 0) and do not feed the
  simulator's slippage limiter or `closed_trades`; there is no queue model.

## 4. Preview

The registered preview is the Vite dev server: **http://127.0.0.1:5173**.
The API on 8787 also serves the built terminal from `apps/web/dist` (`npm run
build -w @kinetix/web` after front-end changes), so both origins must be current.
Pids change on every restart — check with
`netstat -ano | grep -E ":(8787|5173)\s+.*LISTENING"`.
