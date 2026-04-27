-- CreateEnum
CREATE TYPE "Category" AS ENUM ('GENERAL', 'POLITICS', 'ECONOMY', 'ENTERTAINMENT', 'WEATHER', 'TECH', 'FRIENDS');

-- CreateEnum
CREATE TYPE "ChallengeOutcome" AS ENUM ('USER_A', 'USER_B', 'TIE');

-- CreateEnum
CREATE TYPE "ChallengeStatus" AS ENUM ('PENDING_PAYMENT', 'PENDING_JOIN', 'ACTIVE', 'PENDING_RESOLUTION', 'DISPUTED', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('OPEN', 'PAUSED', 'CLOSED', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('MARKET_RESOLVED', 'MARKET_CLOSING_SOON', 'MARKET_PROBABILITY_SHIFT', 'CHALLENGE_OPPONENT_STAKED', 'CHALLENGE_RESOLUTION_WINDOW', 'CHALLENGE_RESOLUTION_WARNING', 'REFEREE_NOMINATED', 'DEPOSIT_CONFIRMED', 'WITHDRAWAL_PROCESSED', 'REFERRAL_REWARD_CREDITED', 'NEW_MARKET_IN_CATEGORY', 'PROMO');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'FILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Outcome" AS ENUM ('YES', 'NO');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'QUALIFIED', 'REWARDED', 'FLAGGED');

-- CreateEnum
CREATE TYPE "RevenueType" AS ENUM ('FORECASTING_FEE', 'MARKET_SURPLUS', 'CHALLENGE_FEE', 'USER_DELETION');

-- CreateEnum
CREATE TYPE "Side" AS ENUM ('YES', 'NO');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRADE_BUY', 'TRADE_SELL', 'PAYOUT', 'REFUND', 'CHALLENGE_STAKE', 'CHALLENGE_PAYOUT', 'SUGGESTION_REWARD', 'CREATOR_BOUNTY', 'REFERRAL_REWARD', 'BONUS_USED');

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ValidatorType" AS ENUM ('MUTUAL', 'REFEREE', 'TIMER');

-- CreateTable
CREATE TABLE "DataApplication" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "orgName" TEXT NOT NULL,
    "orgType" TEXT NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "website" TEXT,
    "planInterest" TEXT NOT NULL,
    "useCase" TEXT NOT NULL,
    "useDescription" TEXT NOT NULL,
    "dataVolume" TEXT,
    "refNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_accounts" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdBy" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_activity_logs" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "detail" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blacklist" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdByAdminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blacklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carousel_slides" (
    "id" TEXT NOT NULL,
    "tag" TEXT,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "imageUrl" TEXT,
    "bgColour" TEXT NOT NULL DEFAULT '#1a1035',
    "ctaText" TEXT,
    "ctaLink" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carousel_slides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_bounties" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "creatorId" TEXT,
    "tradeVolume" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "bountyEarned" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "paidOut" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "lastPaidAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT false,
    "deactivatedAt" TIMESTAMP(3),

    CONSTRAINT "creator_bounties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_challenges" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "accessCode" TEXT NOT NULL,
    "userAId" TEXT,
    "userBId" TEXT,
    "refereeId" TEXT,
    "refereeAccepted" BOOLEAN NOT NULL DEFAULT false,
    "stakePerPerson" DECIMAL(15,2) NOT NULL,
    "totalPool" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "validatorType" "ValidatorType" NOT NULL DEFAULT 'MUTUAL',
    "status" "ChallengeStatus" NOT NULL DEFAULT 'PENDING_JOIN',
    "resolution" "ChallengeOutcome",
    "eventExpiresAt" TIMESTAMP(3) NOT NULL,
    "disputeDeadline" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "userAConfirm" "ChallengeOutcome",
    "userBConfirm" "ChallengeOutcome",
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "feePercent" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "platformFeeKes" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_proposals" (
    "id" TEXT NOT NULL,
    "proposerId" TEXT,
    "question" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "resolutionSource" TEXT NOT NULL,
    "whyCareNote" TEXT,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PENDING',
    "slug" TEXT,
    "rewardPaidAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "markets" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "imageUrl" TEXT,
    "sourceNote" TEXT,
    "creatorId" TEXT,
    "status" "MarketStatus" NOT NULL DEFAULT 'OPEN',
    "outcome" "Outcome",
    "yesPool" DECIMAL(15,2) NOT NULL DEFAULT 1000,
    "noPool" DECIMAL(15,2) NOT NULL DEFAULT 1000,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "totalVolume" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "marketId" TEXT NOT NULL,
    "side" "Side" NOT NULL,
    "amountKes" DECIMAL(15,2) NOT NULL,
    "netAmountKes" DECIMAL(15,2) NOT NULL,
    "forecastingFeeKes" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "bonusUsedKes" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "shares" DECIMAL(15,6) NOT NULL,
    "pricePerShare" DECIMAL(10,6) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'FILLED',
    "creatorAttribution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_codes" (
    "phone" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("phone")
);

-- CreateTable
CREATE TABLE "platform_revenue" (
    "id" TEXT NOT NULL,
    "marketId" TEXT,
    "challengeId" TEXT,
    "type" "RevenueType" NOT NULL,
    "amountKes" DECIMAL(15,2) NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_revenue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "side" "Side" NOT NULL,
    "shares" DECIMAL(15,6) NOT NULL,
    "avgPrice" DECIMAL(10,6) NOT NULL,
    "realizedPnl" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "referrerRewardKes" DECIMAL(10,2) NOT NULL DEFAULT 50,
    "refereeMatchKes" DECIMAL(10,2) NOT NULL DEFAULT 100,
    "minDepositKes" DECIMAL(10,2) NOT NULL DEFAULT 100,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "refereeId" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "referrerRewardKes" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "refereeRewardKes" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "rewardPaidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "challengeId" TEXT,
    "type" "TransactionType" NOT NULL,
    "amountKes" DECIMAL(15,2) NOT NULL,
    "balAfter" DECIMAL(15,2) NOT NULL,
    "mpesaRef" TEXT,
    "phone" TEXT,
    "status" "TxStatus" NOT NULL DEFAULT 'PENDING',
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "balanceKes" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "bonusBalanceKes" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "rewardBalance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "agreedToTerms" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAge" BOOLEAN NOT NULL DEFAULT false,
    "integrityScore" INTEGER NOT NULL DEFAULT 100,
    "referralCode" TEXT,
    "referredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DataApplication_refNumber_key" ON "DataApplication"("refNumber" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "admin_accounts_email_key" ON "admin_accounts"("email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "blacklist_phone_key" ON "blacklist"("phone" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "creator_bounties_marketId_key" ON "creator_bounties"("marketId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "market_challenges_accessCode_key" ON "market_challenges"("accessCode" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "market_proposals_slug_key" ON "market_proposals"("slug" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "markets_slug_key" ON "markets"("slug" ASC);

-- CreateIndex
CREATE INDEX "notifications_userId_read_idx" ON "notifications"("userId" ASC, "read" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "positions_userId_marketId_side_key" ON "positions"("userId" ASC, "marketId" ASC, "side" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "referrals_refereeId_key" ON "referrals"("refereeId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "transactions_mpesaRef_key" ON "transactions"("mpesaRef" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_referralCode_key" ON "users"("referralCode" ASC);

-- AddForeignKey
ALTER TABLE "admin_activity_logs" ADD CONSTRAINT "admin_activity_logs_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admin_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_bounties" ADD CONSTRAINT "creator_bounties_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_bounties" ADD CONSTRAINT "creator_bounties_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_challenges" ADD CONSTRAINT "market_challenges_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_challenges" ADD CONSTRAINT "market_challenges_userAId_fkey" FOREIGN KEY ("userAId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_challenges" ADD CONSTRAINT "market_challenges_userBId_fkey" FOREIGN KEY ("userBId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_proposals" ADD CONSTRAINT "market_proposals_proposerId_fkey" FOREIGN KEY ("proposerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markets" ADD CONSTRAINT "markets_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_revenue" ADD CONSTRAINT "platform_revenue_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "market_challenges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_revenue" ADD CONSTRAINT "platform_revenue_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "market_challenges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

