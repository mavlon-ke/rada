// src/app/api/payments/deposit/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireAuth } from "@/lib/auth/session";
import { initiateSTKPush, formatPhone } from "@/lib/mpesa/mpesa.service";

const DepositSchema = z.object({
  amountKes: z.number().min(10).max(70000),
  phone: z.string().regex(/^(\+?254|0)[17]\d{8}$/, "Invalid Kenyan phone number"),
});

export async function POST(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const parsed = DepositSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { amountKes, phone } = parsed.data;
  const formattedPhone = formatPhone(phone);

  // Create pending transaction
  const transaction = await prisma.transaction.create({
    data: {
      userId: user.id,
      type: "DEPOSIT",
      amountKes,
      balAfter: Number(user.balanceKes) + amountKes,
      phone: formattedPhone,
      status: "PENDING",
      description: `M-Pesa deposit of KES ${amountKes}`,
    },
  });

  try {
    const stkResponse = await initiateSTKPush({
      phone: formattedPhone,
      amountKes,
      accountRef: `PKE-${transaction.id.slice(0, 8).toUpperCase()}`,
      description: `Rada Deposit`,
    });

    // Store checkout request ID for callback matching
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { mpesaRef: stkResponse.CheckoutRequestID },
    });

    return NextResponse.json({
      success: true,
      message: "Check your phone for the M-Pesa prompt",
      checkoutRequestId: stkResponse.CheckoutRequestID,
      transactionId: transaction.id,
    });
  } catch (err: any) {
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { status: "FAILED" },
    });
    return NextResponse.json({ error: "Failed to initiate M-Pesa payment" }, { status: 500 });
  }
}
