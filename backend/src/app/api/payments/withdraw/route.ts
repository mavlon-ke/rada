// src/app/api/payments/withdraw/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireAuth } from "@/lib/auth/session";
import { initiateB2C, formatPhone } from "@/lib/mpesa/mpesa.service";

const WithdrawSchema = z.object({
  amountKes: z.number().min(100).max(70000),
  phone: z.string().regex(/^(\+?254|0)[17]\d{8}$/, "Invalid Kenyan phone number"),
});

const WITHDRAWAL_FEE_PERCENT = 0.01; // 1% withdrawal fee

export async function POST(req: NextRequest) {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (user.kycStatus !== "VERIFIED") {
    return NextResponse.json({ error: "KYC required for withdrawals" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = WithdrawSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { amountKes, phone } = parsed.data;
  const fee = Math.ceil(amountKes * WITHDRAWAL_FEE_PERCENT);
  const totalDeduction = amountKes + fee;
  const formattedPhone = formatPhone(phone);

  // Atomic balance check + deduct
  const result = await prisma.$transaction(async (tx) => {
    const freshUser = await tx.user.findUnique({ where: { id: user.id } });

    if (!freshUser || Number(freshUser.balanceKes) < totalDeduction) {
      throw new Error(`Insufficient balance. Need KES ${totalDeduction} (incl. KES ${fee} fee)`);
    }

    await tx.user.update({
      where: { id: user.id },
      data: { balanceKes: { decrement: totalDeduction } },
    });

    const newBalance = Number(freshUser.balanceKes) - totalDeduction;

    const transaction = await tx.transaction.create({
      data: {
        userId: user.id,
        type: "WITHDRAWAL",
        amountKes: -amountKes,
        balAfter: newBalance,
        phone: formattedPhone,
        status: "PENDING",
        description: `Withdrawal of KES ${amountKes} to ${formattedPhone}`,
      },
    });

    return { transaction, freshUser };
  });

  try {
    const b2cResponse = await initiateB2C({
      phone: formattedPhone,
      amountKes,
      remarks: "Rada Withdrawal",
    });

    await prisma.transaction.update({
      where: { id: result.transaction.id },
      data: { mpesaRef: b2cResponse.ConversationID },
    });

    return NextResponse.json({
      success: true,
      message: `KES ${amountKes} will be sent to ${formattedPhone} shortly`,
      fee,
      transactionId: result.transaction.id,
    });
  } catch (err) {
    // Refund on failure
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { balanceKes: { increment: totalDeduction } },
      });
      await tx.transaction.update({
        where: { id: result.transaction.id },
        data: { status: "FAILED" },
      });
    });

    return NextResponse.json({ error: "Withdrawal failed. Your balance has been restored." }, { status: 500 });
  }
}
