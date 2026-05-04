-- AlterEnum
ALTER TYPE "RevenueType" ADD VALUE 'CREATOR_ROYALTY_PAID';

-- CreateTable
CREATE TABLE "platform_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "creatorRoyaltyRate" DECIMAL(5,4) NOT NULL DEFAULT 0.0050,
    "creatorRoyaltyThresholdKes" DECIMAL(10,2) NOT NULL DEFAULT 1000,
    "creatorProgrammeActive" BOOLEAN NOT NULL DEFAULT true,
    "suggestionRewardKes" DECIMAL(10,2) NOT NULL DEFAULT 50,
    "bountyMinPayoutKes" DECIMAL(10,2) NOT NULL DEFAULT 100,
    "updatedByAdminId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_config_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "platform_config" ADD CONSTRAINT "platform_config_updatedByAdminId_fkey" FOREIGN KEY ("updatedByAdminId") REFERENCES "admin_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
