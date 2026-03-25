// src/lib/auth/session.ts
import { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { prisma } from "@/lib/db/prisma";

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET!);

export async function requireAuth(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "") ?? req.cookies.get("token")?.value;

  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    const userId = payload.sub as string;

    const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, name: true, phone: true,
      balanceKes: true, bonusBalanceKes: true,
      kycStatus: true, referralCode: true,
      createdAt: true,
      // Explicitly exclude sensitive fields
      // passwordHash: false — never returned
    }
  });
    return user;
  } catch {
    return null;
  }
}
