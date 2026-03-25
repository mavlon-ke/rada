## v5 — Challenge Bonus Wallet (March 2026)
- `POST /api/challenges` — full wallet-first payment logic (`balanceKes` → `bonusBalanceKes` → M-Pesa shortfall)
- `BONUS_USED` transaction type logged when bonus balance used in challenge stake
- `PENDING_PAYMENT` status added to `ChallengeStatus` enum (challenge awaiting M-Pesa payment)
- STK push hook added (uncomment and wire when Safaricom B2C approved)
- `.env.example` updated with `CRON_SECRET` and `ADMIN_ALERT_PHONE`
- Migration: `npx prisma migrate dev --name v5-challenge-bonus-wallet`

# Rada 🇰🇪

Kenya's incentivised forecasting platform. Predict real-world events, earn KES via M-Pesa.

**Stack:** Next.js 14 · TypeScript · PostgreSQL + Prisma · M-Pesa Daraja · Africa's Talking · LMSR AMM

---

## Quick Start

```bash
npm install
cp .env.example .env        # fill in your credentials
npm run db:migrate          # create tables
npm run db:seed             # load sample data + admin account
npm run dev                 # start dev server at localhost:3000
```

---

## Architecture

```
rada/
├── prisma/
│   └── schema.prisma          # DB schema (users, markets, challenges, proposals, bounties)
├── scripts/
│   └── seed.ts                # Sample markets + test users + admin account
├── src/
│   ├── app/api/
│   │   ├── auth/otp/          # Phone OTP for users
│   │   ├── admin/auth/login/  # Email+password for admins (separate)
│   │   ├── markets/           # Public market CRUD + trade
│   │   ├── markets/propose/   # User market suggestions (KES 50 reward on approval)
│   │   ├── challenges/        # Friends/Social Escrow create, join, confirm
│   │   ├── payments/          # M-Pesa STK Push + B2C
│   │   ├── users/me/          # Profile, positions, stats, referee queue
│   │   ├── leaderboard/       # Rankings
│   │   └── admin/             # Stats, users, KYC, resolve, disputes, bounties, proposals
│   └── lib/
│       ├── market/amm.ts      # LMSR AMM — pricing, payout, fee calculation
│       ├── mpesa/             # Daraja STK Push + B2C
│       ├── sms/               # Africa's Talking OTP
│       ├── auth/session.ts    # User JWT middleware
│       └── auth/admin.ts      # Admin JWT middleware + activity logger
```

---

## Key Business Rules

| Rule | Value |
|------|-------|
| Min stake (public market) | KES 20 (GRA floor) |
| Max stake (public market) | KES 20,000 per trade |
| Max stake (Friends) | KES 2,000 per person |
| Platform fee (public) | 5% of gross payout |
| Friends fee — mutual/referee | 5% of pool |
| Friends fee — admin intervenes | 15% of pool |
| Creator bounty | 0.5% of platform fees from their market |
| Bounty activates at | KES 1,000 trade volume |
| Suggestion reward | KES 50 auto-credited on admin approval |
| Withdrawal fee | 1% (M-Pesa cost pass-through) |

---

## Auth Design

- **Users** — phone number only → SMS OTP → JWT (24h) stored in httpOnly cookie
- **Admins** — email + password only → separate JWT (12h) stored in `rada_admin_token` cookie
- Admin accounts never use phone OTP. User accounts never use email/password.

---

## Payout Formula (Public Markets)

```typescript
// Each winning share = KES 1 gross
const grossKes = shares;
const feeKes   = Math.floor(grossKes * 0.05);  // 5%
const netKes   = grossKes - feeKes;

// Exception: if 100% of stakes are on one side (unanimous),
// fee is waived and everyone gets a full refund
```

## Payout Formula (Friends)

```typescript
const pool    = stakeA + stakeB;
const feeRate = adminIntervened ? 0.15 : 0.05;
const netPool = pool - Math.floor(pool * feeRate);

// Winner takes netPool (or split equally on TIE, same fee)
```

---

## Deploy to Railway (Recommended)

1. Push code to GitHub
2. Railway → New Project → Deploy from GitHub
3. Add Plugin → PostgreSQL (DATABASE_URL auto-injected)
4. Set environment variables (see `.env.example`)
5. Open Railway Shell → run:
   ```bash
   npm run db:deploy   # run migrations
   npm run db:seed     # load sample data + trending seed orders
   ```
6. Your app is live at `https://your-app.up.railway.app`

**First login:**
- Admin: `admin@rada.co.ke` / `Rada@Admin2024!` → **change immediately**
- User: `254712345678` → request OTP (appears in Railway logs in sandbox)

---

## M-Pesa Sandbox Testing

1. Register at [developer.safaricom.co.ke](https://developer.safaricom.co.ke)
2. Create app → select "Lipa na M-Pesa Sandbox"
3. Copy Consumer Key, Consumer Secret, Passkey to `.env`
4. Use test phone `254708374149` for sandbox STK Push
5. Sandbox PIN: `174379`

---

## Categories

`GENERAL` · `POLITICS` · `ECONOMY` · `ENTERTAINMENT` · `WEATHER` · `TECH` · `FRIENDS`

> ⚠️ **Sports markets are intentionally excluded** to maintain CMA Regulatory Sandbox eligibility and avoid GRA gambling licensing requirements.

---

## Regulatory Notes (Kenya 2026)

- Operating path: **CMA Regulatory Sandbox** (KES 10K fee, 12-month window)
- Platform language: "Forecast / Position" — not "Bet / Gamble"
- 10% Excise Duty applies on service fees (Finance Act 2025)
- KYC tiers: Phone only (KES 500 limit) → M-Pesa link → Gov ID (unlimited)
- Terms & Privacy Policy required before launch
