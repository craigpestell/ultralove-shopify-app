CREATE TABLE "InventorySync" (
    "shop" TEXT NOT NULL,
    "supplierId" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "mappings" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PAUSED',
    "error" TEXT,
    "generation" TEXT,
    "cursor" INTEGER,
    "pending" TEXT,
    "pendingKey" TEXT,
    "pendingAt" DATETIME,
    "nextRunAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("shop", "supplierId")
);
CREATE UNIQUE INDEX "InventorySync_shop_productId_key" ON "InventorySync"("shop", "productId");
CREATE INDEX "InventorySync_shop_enabled_nextRunAt_idx" ON "InventorySync"("shop", "enabled", "nextRunAt");
