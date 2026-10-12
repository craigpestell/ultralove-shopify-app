ALTER TABLE "ImportClaim" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "ImportClaim" ADD COLUMN "listingCheckedAt" DATETIME;
CREATE INDEX "ImportClaim_shop_deletedAt_listingCheckedAt_idx" ON "ImportClaim"("shop", "deletedAt", "listingCheckedAt");
