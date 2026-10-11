ALTER TABLE "ImportJob" ADD COLUMN "listingPolicy" TEXT NOT NULL DEFAULT '{"mode":"KEEP","content":false,"images":false,"prices":false,"links":{},"recreate":[]}';
ALTER TABLE "ImportItem" ADD COLUMN "listing" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "ImportItem" ADD COLUMN "listingWork" TEXT NOT NULL DEFAULT '{}';
