-- AlterTable
ALTER TABLE "users" ADD COLUMN     "whatsappOptedOut" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "whatsapp_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "globalEnabled" BOOLEAN NOT NULL DEFAULT true,
    "depositConfirmedEnabled" BOOLEAN NOT NULL DEFAULT true,
    "withdrawalProcessedEnabled" BOOLEAN NOT NULL DEFAULT true,
    "marketResolvedWonEnabled" BOOLEAN NOT NULL DEFAULT true,
    "marketResolvedLostEnabled" BOOLEAN NOT NULL DEFAULT true,
    "referralRewardCreditedEnabled" BOOLEAN NOT NULL DEFAULT true,
    "refereeNominatedEnabled" BOOLEAN NOT NULL DEFAULT true,
    "challengeOpponentStakedEnabled" BOOLEAN NOT NULL DEFAULT true,
    "challengeResolutionWindowEnabled" BOOLEAN NOT NULL DEFAULT true,
    "challengeResolutionWarningEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedByAdminId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_config_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "whatsapp_config" ADD CONSTRAINT "whatsapp_config_updatedByAdminId_fkey" FOREIGN KEY ("updatedByAdminId") REFERENCES "admin_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
