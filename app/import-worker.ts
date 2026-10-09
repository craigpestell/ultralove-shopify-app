import { setTimeout } from "node:timers/promises";
import db from "./db.server";
import shopify from "./shopify.server";
import { LAB_SHOP, assertLabShop } from "./lab-policy.server";
import { runJob } from "./imports.server";

let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

assertLabShop(LAB_SHOP);
await db.importJob.updateMany({ where: { shop: LAB_SHOP, status: "RUNNING" }, data: { status: "QUEUED" } });
console.info("Lab-only draft import worker ready.");
while (!stopping) {
  const job = await db.importJob.findFirst({ where: { shop: LAB_SHOP, status: "QUEUED" }, orderBy: { createdAt: "asc" } });
  if (job) {
    try {
      const { admin, session } = await shopify.unauthenticated.admin(LAB_SHOP);
      assertLabShop(session.shop);
      await runJob(job.id, LAB_SHOP, async (query, variables) => {
        const response = await admin.graphql(query, { variables, tries: 1 });
        return response.json();
      }, () => stopping);
    } catch (error) {
      console.error("Import worker access failed.", job.id, error instanceof Error ? error.message : "Unknown failure");
      await db.importJob.update({ where: { id: job.id }, data: { status: "FAILED", activeShop: null,
        error: "Shopify access could not be established. Reopen the app, then retry the job." } });
    }
  } else {
    await setTimeout(2000);
  }
}
await db.$disconnect();
