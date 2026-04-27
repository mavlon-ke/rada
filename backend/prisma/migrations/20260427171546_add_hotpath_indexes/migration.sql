-- CreateIndex
CREATE INDEX "markets_status_category_createdAt_idx" ON "markets"("status", "category", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "markets_status_closesAt_idx" ON "markets"("status", "closesAt");

-- CreateIndex
CREATE INDEX "orders_marketId_idx" ON "orders"("marketId");

-- CreateIndex
CREATE INDEX "transactions_userId_status_createdAt_idx" ON "transactions"("userId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "transactions_type_status_createdAt_idx" ON "transactions"("type", "status", "createdAt" DESC);
