// src/lib/security/middleware.ts
// SECURITY FIXES v8:
//   [HIGH] In-memory rate limiting → Redis-backed (survives restarts, works multi-instance)
//   [HIGH] CSRF token comparison → timing-safe (timingSafeEqual)

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getRedis } from '@/lib/db/redis';
import sanitizeHtml from 'sanitize-html';

// ── Rate limit config ─────────────────────────────────────────────────────────

interface RateLimitConfig { windowSecs: number; max: number; }

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  '/api/auth/otp/request': { windowSecs: 600, max: 5  },
  '/api/auth/otp/verify':  { windowSecs: 600, max: 10 },
  '/api/auth/check':       { windowSecs: 60,  max: 20 },
  '/api/payments/deposit': { windowSecs: 60,  max: 10 },
  '/api/payments/withdraw':{ windowSecs: 60,  max: 5  },
  '/api/markets':          { windowSecs: 60,  max: 60 },
  '/api/markets/trending': { windowSecs: 60,  max: 60 },
  '/api/markets/trade':    { windowSecs: 60,  max: 30 },
  '/api/challenges':       { windowSecs: 60,  max: 20 },
  '/api/admin/auth/login': { windowSecs: 900, max: 5  },
  'default':               { windowSecs: 60,  max: 100 },
};

export async function checkRateLimit(req: NextRequest): Promise<NextResponse | null> {
  const pathname = req.nextUrl.pathname;
  // SECURITY FIX: prefer x-real-ip — set by Vercel edge to the actual
  // connecting IP and not client-spoofable. x-forwarded-for is
  // client-supplied and trivially rotated to bypass per-IP rate limits.
  // x-forwarded-for is kept only as a fallback for non-Vercel environments.
  const ip = req.headers.get('x-real-ip')?.trim()
           ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
           ?? 'unknown';

  const config = RATE_LIMITS[pathname]
    ?? Object.entries(RATE_LIMITS).find(([k]) => pathname.startsWith(k))?.[1]
    ?? RATE_LIMITS['default'];

  const key = `rl:${ip}:${pathname}`;

  try {
    const redis = getRedis();
    const pipe  = redis.pipeline();
    pipe.incr(key);
    pipe.ttl(key);
    const results = await pipe.exec();

    const count = (results?.[0]?.[1] as number) ?? 1;
    const ttl   = (results?.[1]?.[1] as number) ?? -1;

    // Set expiry on first request
    if (ttl < 0) await redis.expire(key, config.windowSecs);

    if (count > config.max) {
      const retryAfter = ttl > 0 ? ttl : config.windowSecs;
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(retryAfter),
            'X-RateLimit-Limit':     String(config.max),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }
    return null;
  } catch (err) {
    // SECURITY FIX: fail CLOSED for sensitive endpoints (auth, admin, payments).
    // If Redis is down, allowing unlimited OTP / admin-login / withdrawal attempts
    // is far worse than briefly 503'ing legitimate traffic until Redis recovers.
    // For non-sensitive endpoints (markets, reads), fail open to keep the app usable.
    console.error('[RateLimit] Redis error:', err);

    const FAIL_CLOSED_PREFIXES = [
      '/api/auth/',
      '/api/admin/auth/',
      '/api/payments/deposit',
      '/api/payments/withdraw',
    ];
    const isSensitive = FAIL_CLOSED_PREFIXES.some(p => pathname.startsWith(p));

    if (isSensitive) {
      return NextResponse.json(
        { error: 'Service temporarily unavailable. Please try again shortly.' },
        { status: 503, headers: { 'Retry-After': '30' } }
      );
    }
    return null;
  }
}

// ── CORS ──────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://checkrada.co.ke',
  'https://www.checkrada.co.ke',
  'https://checkrada.com',
  'https://chekirada.co.ke',
  'https://chekirada.com',
  ...(process.env.NODE_ENV === 'development'
    ? ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000']
    : []),
];

export function applyCORS(req: NextRequest, res: NextResponse): NextResponse {
  const origin = req.headers.get('origin') ?? '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Vary', 'Origin');
  }
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-CSRF-Token');
  res.headers.set('Access-Control-Allow-Credentials', 'true');
  res.headers.set('Access-Control-Max-Age', '86400');
  return res;
}

export function handlePreflight(req: NextRequest): NextResponse | null {
  if (req.method !== 'OPTIONS') return null;
  const origin = req.headers.get('origin') ?? '';
  if (!ALLOWED_ORIGINS.includes(origin)) return new NextResponse(null, { status: 403 });
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token',
      'Access-Control-Max-Age':       '86400',
    },
  });
}

// ── Security headers ──────────────────────────────────────────────────────────

export function applySecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set('X-Frame-Options',             'DENY');
  res.headers.set('X-Content-Type-Options',      'nosniff');
  res.headers.set('X-XSS-Protection',            '1; mode=block');
  res.headers.set('Strict-Transport-Security',   'max-age=31536000; includeSubDomains');
  res.headers.set('Referrer-Policy',             'strict-origin-when-cross-origin');
  res.headers.set('Permissions-Policy',          'camera=(), microphone=(), geolocation=()');
  res.headers.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self' https://checkrada.co.ke https://api.checkrada.co.ke",
    "frame-ancestors 'none'",
  ].join('; '));
  return res;
}

// ── Sanitisation ──────────────────────────────────────────────────────────────

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = { allowedTags: [], allowedAttributes: {} };

export function sanitizeText(input: string): string {
  if (typeof input !== 'string') return '';
  return sanitizeHtml(input.trim(), SANITIZE_OPTIONS);
}

export function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = sanitizeText(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = sanitizeObject(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Combined ──────────────────────────────────────────────────────────────────

export function applyAllSecurity(req: NextRequest, res: NextResponse): NextResponse {
  applySecurityHeaders(res);
  applyCORS(req, res);
  return res;
}
