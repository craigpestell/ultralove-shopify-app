import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, redirect, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateLabAdmin } from "../shopify.server";
import db from "../db.server";
import { browseFilters, selectionIds } from "../catalog-policy";
import { allCategories, CatalogError, productsPage, validateSelection } from "../catalog.server";
import { ImportError, importChoices, markupPercent } from "../import-engine";
import { createPreview, importScreen, queueJob } from "../imports.server";
import { markupOverrides, PricingError } from "../pricing-policy";
import type { MarkupOverrides } from "../pricing-policy";
import CatalogWorkspace from "../catalog-workspace";
import { ListingPolicyError, defaultListingPolicy } from "../listing-policy";
import { listingInput } from "../workspace-policy";
import { FulfillmentError, fulfillmentModes } from "../fulfillment-policy";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticateLabAdmin(request);
  const url = new URL(request.url);
  const jobs = url.searchParams.getAll("job");
  if (jobs.length > 1 || (jobs.length && !/^[a-f0-9]{32}$/.test(jobs[0]))) throw new Response("Invalid import job identifier.", { status: 400 });
  let filters;
  try { filters = browseFilters(url); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new Response(error.message, { status: 400 });
  }
  // Categories load in full and sorted, so the legacy category_after cursor is ignored.
  const productFilters = { search: filters.search, category_id: filters.category_id, after_id: filters.after_id };
  const screen = await importScreen(session.shop, jobs[0] || null);
  if (["review", "imports"].includes(url.searchParams.get("view") || "") || (!url.searchParams.has("view") && jobs.length)) {
    return { shop: session.shop, ...screen, filters, products: null, categories: null, error: null };
  }
  try {
    const [products, categories] = await Promise.all([productsPage(productFilters), allCategories()]);
    return { shop: session.shop, ...screen, filters, products, categories, error: null };
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;
    console.error("Catalog browsing failed.", error.message);
    return data({ shop: session.shop, ...screen, filters, products: null, categories: null, error: error.message }, { status: 502 });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticateLabAdmin(request);
  const form = await request.formData();
  const url = new URL(request.url);
  const destination = (job?: string, view = "review") => {
    url.searchParams.delete("index");
    if (job) url.searchParams.set("job", job);
    url.searchParams.set("view", view);
    return `/app${url.search}`;
  };
  try {
    const field = (name: string, max = 1000) => {
      const values = form.getAll(name);
      if (values.length !== 1 || typeof values[0] !== "string" || values[0].length > max) {
        throw new ImportError(`Supply exactly one valid ${name} field.`);
      }
      return values[0];
    };
    const intent = field("intent");
    if (intent === "queue" || intent === "retry") {
      const id = field("job");
      if (!/^[a-f0-9]{32}$/.test(id)) throw new ImportError("Invalid import job identifier.");
      await queueJob(session.shop, id, intent === "retry", field("confirm"));
      return redirect(destination(id, "imports"));
    }
    if (intent !== "preview" && intent !== "save-selection" && intent !== "save-configuration") throw new ImportError("Invalid catalog action.");
    // Keep legacy preview forms usable with saved selections and global-only markup.
    if (intent === "preview" && !form.has("ids")) {
      if (form.has("listing-policy")) throw new ImportError("Supply selected products when configuring listing updates.");
      const job = await createPreview(session.shop, markupPercent(field("markup")), async (query, variables) => {
        const response = await admin.graphql(query, { variables, tries: 1 });
        return response.json();
      }, importChoices(form));
      return redirect(destination(job.id));
    }
    let ids: number[];
    try { ids = selectionIds(JSON.parse(field("ids", Infinity))); } catch { throw new ImportError("Select distinct positive supplier product IDs."); }
    const hasPricing = intent !== "save-selection";
    let modes;
    if (form.has("fulfillment-modes")) {
      let value: unknown;
      try { value = JSON.parse(field("fulfillment-modes", Infinity)); }
      catch { throw new FulfillmentError("Invalid product fulfillment choices."); }
      modes = fulfillmentModes(value, ids);
    } else {
      modes = {};
    }
    const markup = hasPricing ? markupPercent(field("markup")) : undefined;
    let markups: MarkupOverrides | undefined;
    if (hasPricing) {
      try { markups = markupOverrides(JSON.parse(field("markups", Infinity)), ids); }
      catch (error) {
        if (error instanceof PricingError) throw error;
        throw new ImportError("Invalid per-product markup overrides.");
      }
    }
    if (intent === "preview") {
      let policy = defaultListingPolicy();
      if (form.has("listing-policy")) {
        const input = field("listing-policy", Infinity);
        let value: unknown;
        try { value = JSON.parse(input); }
        catch { throw new ListingPolicyError("Invalid existing-product configuration."); }
        policy = listingInput(value, ids);
      }
      const job = await createPreview(session.shop, markup!, async (query, variables) => {
        const response = await admin.graphql(query, { variables, tries: 1 });
        return response.json();
      }, importChoices(form), { ids, markups: markups!, fulfillmentModes: modes }, policy);
      return redirect(destination(job.id));
    }
    await validateSelection(ids);
    const pricing = hasPricing ? { markup, markups: JSON.stringify(markups), fulfillmentModes: JSON.stringify(modes) }
      : { markups: "{}", fulfillmentModes: JSON.stringify(modes) };
    await db.catalogSelection.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, productIds: JSON.stringify(ids), ...pricing },
      update: { productIds: JSON.stringify(ids), ...pricing },
    });
    return data({ error: null, saved: true });
  } catch (error) {
    if (!(error instanceof ImportError) && !(error instanceof CatalogError) && !(error instanceof PricingError) && !(error instanceof ListingPolicyError) && !(error instanceof FulfillmentError)) throw error;
    console.warn("Catalog/import request rejected.", error.message);
    return data({ error: error.message, saved: false }, { status: error instanceof CatalogError ? 502 : 400 });
  }
};

export default CatalogWorkspace;
export function ErrorBoundary() { return boundary.error(useRouteError()); }
export const headers: HeadersFunction = (args) => boundary.headers(args);
