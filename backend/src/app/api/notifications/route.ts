// src/app/api/notifications/route.ts
// Internal helper — creates notifications. Called by other routes, not directly by frontend.
// Also exposes POST for programmatic use within the app.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';



// POST endpoint for internal/admin use
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { userId, type, title, message, link } = body;
  if (!userId || !type || !title || !message) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }
  const notification = await createNotification({ userId, type, title, message, link });
  return NextResponse.json({ notification }, { status: 201 });
}
