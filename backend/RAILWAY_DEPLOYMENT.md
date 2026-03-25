# Railway Deployment Guide — CheckRada Backend v8
# Generated: 24 March 2026

## OVERVIEW
Railway hosts: Next.js backend + PostgreSQL + Redis
Live URL after setup: https://api.checkrada.co.ke

---

## STEP 1 — Create Railway Account
1. Go to railway.app
2. Click Login → Login with GitHub
3. Authorise Railway
4. You're in. Free tier = $5 credit/month (testing only).
   Upgrade to Hobby ($5/month) before going live with real users.

---

## STEP 2 — Create Project
1. Click New Project
2. Select Deploy from GitHub repo
3. Find and select: mavlon-ke/rada
4. Railway detects Next.js automatically
5. Click Deploy Now — WILL FAIL (no env vars yet — expected)

---

## STEP 3 — Add PostgreSQL
1. Inside your project, click + New
2. Database → Add PostgreSQL
3. DATABASE_URL is set automatically as a shared variable
4. Click PostgreSQL service → Connect tab → copy the connection string
   (You'll need it to run migrations from local machine)

---

## STEP 4 — Add Redis
1. Click + New → Database → Add Redis
2. REDIS_URL is set automatically
3. Used for: rate limiting, admin lockout, OTP attempt tracking

---

## STEP 5 — Set Environment Variables
1. Click your main app service (the Next.js one)
2. Go to Variables tab
3. Click Raw Editor and add all vars from .env.example:

   DATABASE_URL                → auto-set (do NOT override)
   REDIS_URL                   → auto-set (do NOT override)
   JWT_SECRET                  → openssl rand -base64 64
   CSRF_SECRET                 → openssl rand -base64 32
   CRON_SECRET                 → openssl rand -base64 32
   WHATSAPP_PHONE_NUMBER_ID    → from Meta
   WHATSAPP_WABA_ID            → from Meta
   WHATSAPP_ACCESS_TOKEN       → permanent system user token
   WHATSAPP_OTP_TEMPLATE_NAME  → checkrada_otp
   NODE_ENV                    → production
   NEXT_PUBLIC_BASE_URL        → https://api.checkrada.co.ke
   ADMIN_SEED_PASSWORD         → strong unique password (temp — remove after seeding)

4. Save → Railway auto-redeploys

---

## STEP 6 — Run Database Migrations (from your local machine)

```bash
# Set your Railway DATABASE_URL temporarily
export DATABASE_URL="postgresql://..."   # paste from Railway Connect tab

# Run all pending migrations
npx prisma migrate deploy

# Confirm all applied
npx prisma migrate status
```

---

## STEP 7 — Seed Database (Admin User + Markets)

```bash
export DATABASE_URL="postgresql://..."  # Railway DB URL
export ADMIN_SEED_PASSWORD="YourStrongPasswordHere123!"

npm run db:seed
```

OUTPUT you should see:
  ✅ User A seeded
  ✅ User B seeded
  ✅ Admin: admin@checkrada.co.ke (bcrypt hashed)
  ✅ 10 markets seeded
  ✅ 63 sample orders seeded
  ✅ Sample challenge + proposal created
  ✅ Referral config seeded

⚠️  IMMEDIATELY after seed completes:
    Remove ADMIN_SEED_PASSWORD from Railway Variables tab

---

## STEP 8 — Get Your Railway App URL
1. App service → Settings → Domains
2. Copy the *.up.railway.app URL
3. You'll use this in the next step

---

## STEP 9 — Point api.checkrada.co.ke → Railway

In Cloudflare (dash.cloudflare.com → checkrada.co.ke → DNS):
1. Add record:
   Type:   CNAME
   Name:   api
   Target: your-app.up.railway.app  (no https://)
   Proxy:  ON (orange cloud)
   TTL:    Auto

2. In Railway → app → Settings → Custom Domains:
   Add: api.checkrada.co.ke
   Railway shows verification status → goes green in minutes

---

## STEP 10 — Smoke Test

```bash
# Test OTP request (replace with a real WhatsApp number)
curl -X POST https://api.checkrada.co.ke/api/auth/otp/request \
  -H "Content-Type: application/json" \
  -d '{"phone":"07XXXXXXXX"}'

# Expected: {"message":"OTP sent via WhatsApp. Check your messages."}

# Test markets list
curl https://api.checkrada.co.ke/api/markets
# Expected: {"markets":[...10 markets...]}
```

---

## DEPLOYMENT CHECKLIST

- [ ] Railway project created + GitHub repo connected
- [ ] PostgreSQL plugin added
- [ ] Redis plugin added
- [ ] All env vars set (10 required)
- [ ] npx prisma migrate deploy — all migrations applied
- [ ] npm run db:seed — seeded successfully
- [ ] ADMIN_SEED_PASSWORD removed from Railway vars
- [ ] api.checkrada.co.ke CNAME set in Cloudflare
- [ ] Custom domain verified in Railway
- [ ] Smoke test: OTP request returns 200 + WhatsApp arrives
- [ ] Smoke test: /api/markets returns market list

---

## COSTS

| Service        | Plan   | Cost/month |
|----------------|--------|------------|
| Railway app    | Hobby  | $5         |
| PostgreSQL     | Hobby  | included   |
| Redis          | Hobby  | included   |
| WhatsApp OTP   | Meta   | Free (1,000 convos/month) |
| Frontend       | GitHub Pages | Free |
| DNS/CDN        | Cloudflare | Free |

Total: ~$5/month until significant user scale.
