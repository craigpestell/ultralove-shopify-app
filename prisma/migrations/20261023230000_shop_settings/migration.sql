-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "inventoryPaused" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);

-- Carry the lab's host-wide pause over to the lab store, the only store it applied to.
INSERT INTO "ShopSettings" ("shop", "inventoryPaused", "updatedAt")
SELECT 'ultralove-integration-lab.myshopify.com', "inventoryPaused", "updatedAt" FROM "AppSettings" WHERE "id" = 'lab' AND "inventoryPaused" = true;
