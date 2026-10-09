CREATE TABLE "CatalogSelection" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "productIds" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL
);
