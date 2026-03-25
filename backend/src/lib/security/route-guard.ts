// src/lib/security/route-guard.ts
// Wraps route handlers with standard error handling + security checks

import { NextRequest, NextResponse } from 'next/server';

type RouteHandler = (req: NextRequest, ctx?: any) => Promise<NextResponse>;

/**
 * Wraps a route handler with:
 * - Global try/catch error handling
 * - Prevents raw stack traces leaking to clients
 */
export function withErrorHandling(handler: RouteHandler): RouteHandler {
  return async (req: NextRequest, ctx?: any) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      // Log full error server-side
      console.error(`[Route Error] ${req.method} ${req.nextUrl.pathname}:`, err);

      // Return generic error to client — never expose stack traces
      if (err instanceof SyntaxError) {
        return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 });
      }

      return NextResponse.json(
        { error: 'An unexpected error occurred. Please try again.' },
        { status: 500 }
      );
    }
  };
}
