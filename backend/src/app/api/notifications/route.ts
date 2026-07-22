// src/app/api/notifications/route.ts
// Internal helper — creates notifications. Called by other routes, not directly by frontend.
// Also exposes POST for programmatic use within the app.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { createNotification } from '@/lib/notifications';
import { requireAdmin, adminUnauthorized } from '@/lib/auth/admin';
import { withErrorHandling } from '@/lib/security/route-guard';

// POST endpoint — admin-only. All internal call sites use createNotification() lib directly.
// This HTTP endpoint is kept for admin-panel programmatic use only.
export const POST = withErrorHandling(async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return adminUnauthorized();

  const body = await req.json();
  const { userId, type, title, message, link } = body;
  if (!userId || !type || !title || !message) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }
  const notification = await createNotification({ userId, type, title, message, link });
  return NextResponse.json({ notification }, { status: 201 });
});
