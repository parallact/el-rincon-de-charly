-- CreateTable
CREATE TABLE "BetStake" (
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "settled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BetStake_pkey" PRIMARY KEY ("roomId","userId")
);

-- CreateIndex
CREATE INDEX "BetStake_roomId_idx" ON "BetStake"("roomId");

-- CreateTable
CREATE TABLE "DailyBonus" (
    "userId" TEXT NOT NULL,
    "bonusDate" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyBonus_pkey" PRIMARY KEY ("userId","bonusDate")
);
