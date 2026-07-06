
-- CreateTable
CREATE TABLE "PlinkoSeed" (
    "userId" TEXT NOT NULL,
    "serverSeed" TEXT NOT NULL,
    "serverSeedHash" TEXT NOT NULL,
    "clientSeed" TEXT NOT NULL,
    "nonce" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlinkoSeed_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "PlinkoRound" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "betAmount" DECIMAL(15,2) NOT NULL,
    "rows" INTEGER NOT NULL,
    "serverSeedHash" TEXT NOT NULL,
    "clientSeed" TEXT NOT NULL,
    "nonce" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "multiplier" DECIMAL(10,4) NOT NULL,
    "winAmount" DECIMAL(15,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlinkoRound_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlinkoRound_userId_idx" ON "PlinkoRound"("userId");

-- AddForeignKey
ALTER TABLE "PlinkoSeed" ADD CONSTRAINT "PlinkoSeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlinkoRound" ADD CONSTRAINT "PlinkoRound_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

