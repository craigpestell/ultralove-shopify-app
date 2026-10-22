-- CreateTable
CREATE TABLE "FeedVersionCheck" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'lab',
    "checkedAt" DATETIME NOT NULL,
    "trigger" TEXT NOT NULL,
    "version" TEXT,
    "result" TEXT NOT NULL,
    "reason" TEXT
);
