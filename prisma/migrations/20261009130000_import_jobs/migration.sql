CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "activeShop" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PREVIEW',
    "selection" TEXT NOT NULL,
    "markup" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "generation" TEXT NOT NULL,
    "cursor" INTEGER NOT NULL,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ImportJob_activeShop_key" ON "ImportJob"("activeShop");
CREATE INDEX "ImportJob_shop_createdAt_idx" ON "ImportJob"("shop", "createdAt");
CREATE TABLE "ImportItem" (
    "jobId" TEXT NOT NULL,
    "supplierId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "wholesale" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "productId" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY ("jobId", "supplierId"),
    CONSTRAINT "ImportItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ImportJob" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "ImportClaim" (
    "shop" TEXT NOT NULL,
    "supplierId" INTEGER NOT NULL,
    "runId" TEXT NOT NULL,
    "productId" TEXT,
    "mutationStartedAt" DATETIME,
    PRIMARY KEY ("shop", "supplierId")
);
