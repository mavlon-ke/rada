// src/lib/market/slug.ts
// Generates URL-safe slugs for market share links
// Format: rada.co.ke/m/[slug]?c=[creatorPhone]

import { prisma } from '@/lib/db/prisma';

/**
 * Converts a market title into a URL-safe slug.
 * "Will William Ruto complete his first term?" → "will-william-ruto-complete-first-term"
 */
export function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')   // strip special chars
    .trim()
    .replace(/\s+/g, '-')           // spaces → hyphens
    .replace(/-+/g, '-')            // collapse multiple hyphens
    .slice(0, 60)                    // max 60 chars
    .replace(/-$/, '');             // trim trailing hyphen
}

/**
 * Generates a unique slug, appending a short suffix if the base slug is taken.
 */
export async function generateUniqueSlug(title: string): Promise<string> {
  const base = titleToSlug(title);
  
  // Try base slug first
  const exists = await prisma.market.findUnique({ where: { slug: base } });
  if (!exists) return base;

  // Append short random suffix until unique
  for (let i = 0; i < 10; i++) {
    const suffix = Math.random().toString(36).slice(2, 6);
    const candidate = `${base}-${suffix}`;
    const taken = await prisma.market.findUnique({ where: { slug: candidate } });
    if (!taken) return candidate;
  }

  // Absolute fallback: timestamp
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Builds the full shareable URL for a market.
 * If creatorPhone provided, appends ?c= for bounty attribution.
 */
export function buildMarketShareUrl(
  slug: string,
  creatorPhone?: string | null,
  base = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://rada.co.ke'
): string {
  const url = `${base}/m/${slug}`;
  return creatorPhone ? `${url}?c=${encodeURIComponent(creatorPhone)}` : url;
}
