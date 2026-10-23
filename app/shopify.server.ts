import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { redirect } from "react-router";
import { assertShopDomain, assertSingleLoginShop, assertSingleShop, isApprovedShop } from "./shop-policy.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
/** Authenticates any store that installed the app, approved or not. */
export async function authenticateShopAdmin(request: Request) {
  assertSingleShop(request);
  const context = await shopify.authenticate.admin(request);
  assertShopDomain(context.session.shop);
  return context;
}

/**
 * Authenticates a store UltraLove approved. Other stores go to the waiting-for-approval page,
 * keeping the embedded query so App Bridge authentication still works there.
 */
export async function authenticateRetailer(request: Request) {
  const context = await authenticateShopAdmin(request);
  if (!(await isApprovedShop(context.session.shop))) throw redirect(`/app/pending${new URL(request.url).search}`);
  return context;
}

export async function login(request: Request) {
  await assertSingleLoginShop(request);
  return shopify.login(request);
}
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
