# CheckRada Backend — Security Guide

## Pre-Deployment Security Checklist

### Critical — Must do before first deploy:
- [ ] Change ADMIN_SEED_PASSWORD to a strong unique password (min 16 chars, mixed case, numbers, symbols)
- [ ] Generate a strong JWT_SECRET (min 32 random characters)
- [ ] Generate a strong CRON_SECRET (min 32 random characters)
- [ ] Set NODE_ENV=production on Railway
- [ ] Set ALLOWED_ORIGINS to https://checkrada.co.ke

### After deploy:
- [ ] Run: npm run db:deploy (not db:migrate in production)
- [ ] Run: npm run db:seed (then immediately log in and change admin password)
- [ ] Run: npm audit --audit-level=high
- [ ] Verify rate limiting is working: try 6 OTP requests — should get 429 on 6th

## Security Architecture

### Rate Limiting
- OTP request: 5 per phone per 10 minutes
- OTP verify: 10 attempts per phone per 10 minutes  
- Admin login: 5 attempts per IP per 15 minutes
- All other endpoints: 100 requests per IP per minute

### CORS
Only these origins are allowed:
- https://checkrada.co.ke
- https://www.checkrada.co.ke
- https://checkrada.com
- https://chekirada.co.ke
- https://chekirada.com

### HTTP Security Headers
Applied to all API responses:
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- Strict-Transport-Security: max-age=31536000
- Content-Security-Policy: (see middleware.ts)

### Callback Verification
Kopokopo callbacks are verified using HMAC-SHA256 signature.
Never accept a payment without verifying the signature.

## Incident Response
If a security breach is suspected:
1. Immediately rotate JWT_SECRET on Railway (forces all users to re-login)
2. Rotate Kopokopo API keys
3. Notify users via SMS within 72 hours (Kenya Data Protection Act 2019 requirement)
4. Document the incident
5. Report to Kenya Data Commissioner if personal data was compromised

## Security Fixes Applied (v7)

### High Severity (Fixed):
1. Admin login lockout — 5 failed attempts = 30 min lockout per IP
2. Timing-safe password comparison — prevents timing attacks
3. Raw SQL replaced with Prisma typed queries in OTP routes
4. Next.js upgraded from 14.1.0 to 14.2.29 (CVE patches)

### Medium Severity (Fixed):
5. CSRF protection added — double-submit cookie pattern
6. Global error handler — prevents stack trace leaks
7. Admin route error handling — 3 routes wrapped
8. Redis security — password documentation + private network guidance

### Security Architecture Update:
- All 8 remaining issues resolved
- Total issues: 18 found → 0 remaining
- Global middleware handles: Rate limiting + CORS + Security headers + CSRF
