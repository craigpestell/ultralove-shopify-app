# UltraLove Dropshipping Project

## Client overview and Shopify lab walkthrough

**Prepared: October 11, 2026**

**Environment: integration lab / demonstration store, not production**

## 1. What we are building

The project is intended to make it easier for approved retailers to sell
UltraLove products through Shopify and, ultimately, have UltraLove fulfil
approved orders directly to their customers.

There are two related parts:

- **Shopify catalog and inventory app:** browse UltraLove's products, choose
  which products to carry, set retail pricing, import or update Shopify
  listings, and optionally synchronize supplier-backed stock.
- **Dropshipping fulfilment:** the approval, ordering and warehouse process
  for shipping directly to a retailer's customer. A separate WooCommerce
  dropshipping checkout has been developed and tested on development.
  Shopify order forwarding and tracking are not yet a completed feature of
  this app.

The Shopify lab demonstrates the catalog, pricing, import and inventory
workflow. It is connected to UltraLove's development product feed and contains
real catalog information and test-store listings.

## 2. Access the Shopify lab

**Shopify admin login:**

[Open the UltraLove integration lab](https://admin.shopify.com/store/ultralove-integration-lab)

**Store domain:** `ultralove-integration-lab.myshopify.com`

**App name:** **UltraLove Catalog** (formerly **UltraLove Dropshipping Lab**)

### Your login details

| Item | Details |
|---|---|
| Login email | Your authorized Shopify account email, to be confirmed privately by the project team |
| Password | Your own Shopify account password; set it through Shopify if creating a new account |
| Store access | A dedicated invitation/access grant from the store owner is recommended |
| Two-step authentication | Complete Shopify's verification prompt if requested |

**Access must be arranged before this walkthrough.** If you receive a Shopify
invitation, accept it using the invited email address. An existing Shopify
account does not automatically grant access to this store.

For security, passwords, recovery codes and one-time login codes are not included
in this document. If an existing review account is being used instead, its
credentials must be supplied separately through an approved private channel.
Do not use UltraLove's WordPress login to sign in to Shopify.

## 3. Open the UltraLove Catalog app

1. Open the Shopify admin link above and sign in.
2. Confirm that the selected store is **ultralove-integration-lab**.
3. Open **Apps** in Shopify's navigation or app menu.
4. Select **UltraLove Catalog**. If it is not immediately visible,
   use Shopify's search to find the installed app by that name.
5. The app opens inside Shopify admin. Its main workspace provides
   **Catalog**, **Selection & pricing**, **Imports**, and **Inventory**.
   Creating a pricing preview opens the **Review import** view.

If the store or app is not available, ask the project team to check your store
membership and app permissions. You should not need to install another app,
change store settings, or use the app's hosting URL directly.

## 4. Suggested walkthrough

### A. Browse the catalog

Open **Catalog** to see **UltraLove's catalog**.

- Search by product name or SKU and filter by category.
- Browse additional catalog pages.
- Review product images, supplier wholesale prices, estimated retail prices,
  and availability.
- Availability such as **327 units** represents supplier stock; it is not
  automatically the stock of an existing Shopify listing.

Selecting products does not import them or change stock.

### B. Review selection and retail pricing

Open **Selection & pricing**.

- Set a default percentage markup for the selection.
- Set an individual markup for a specific product.
- Use **Use default for all ... products** to remove individual overrides.
- Search selected products by name, SKU or supplier ID. The list shows
  25 products per page, so large selections remain manageable.
- **Save changes** saves the selection and pricing without importing.
- Under **How will you fulfill these products?**, choose a mode for the whole
  selection, or choose separately beside each product:
  - **Catalog only — my own stock** is the default. Import product content
    without UltraLove inventory quantities or supplier sync. Set your own stock
    in Shopify before publishing.
  - **Dropshipping — supplier inventory** imports supplier availability and
    makes the product eligible for separately confirmed inventory sync.
    It does not approve or enable order forwarding.

For example, a CAD \$10.00 supplier price with a 50% markup produces a
CAD \$15.00 retail price. Markup is not profit margin. Shipping, taxes, fees and
currency conversion are not included in this calculation.

### C. Preview before importing

Choose **Create pricing preview** to open the pricing snapshot.

The review shows the proposed products, exact variant prices and any warnings.
It also identifies existing listings, proposed updates and any replacements
for listings confirmed missing.

- Existing listings default to **Keep unchanged**.
- Updating existing listings requires explicitly choosing the fields to update.
- New products default to unpublished drafts.
- **Set new products to Active** and **Publish new products to Online Store**
  are optional choices and should remain off for an ordinary demonstration.
- No import or update starts until the review is explicitly confirmed.

The snapshot has search and 25-product pages. Confirmation applies to the
**entire snapshot**, not just the current page or search results. Previews
expire after ten minutes; create a fresh preview if needed.

### D. Review import results

Open **Imports** and choose an entry in **Recent activity**.

- Review completed products, warnings and any unfinished items.
- Use **Open in Shopify (new tab)** to inspect an individual listing.
- Search or page through the results.
- Where permitted, **Retry unfinished items** reconciles unfinished work;
  completed products are not imported again.
- Expired update previews and some connection issues require a fresh review.

An error is kept visible rather than silently treating incomplete work as a
success. For example, a missing or invalid supplier image can fail Shopify's
media processing. The source image must be repaired and failed media reviewed
before trying again; the app does not repeatedly upload duplicates.

### E. Review inventory synchronization

Open **Inventory**.

Inventory sync is opt-in for imported **dropshipping-mode** products only.
Catalog-only products remain retailer-managed and cannot be enrolled, even
with **Enable all**. Enabled products are
scheduled about every five minutes, with queued imports taking priority.

- **Enable inventory sync** requires explicit confirmation.
- **Sync now** requests a cycle for an enabled product.
- **Pause sync** prevents new updates; an update already sent may finish.
- Sync updates supplier-backed on-hand stock, while retaining Shopify order
  reservations. It does not change retail prices, descriptions or publication.
- If a linked Shopify listing is missing, sync pauses in **Needs review**.
  Recovery requires a reviewed reconnection or replacement and explicit
  re-enrollment.

Removing a product from a working catalog selection does not automatically
pause its inventory sync.

Use **Enable inventory sync for all** to confirm inventory-only sync for every
currently imported eligible product. Select its confirmation checkbox, then
choose the button. It applies to the entire imported list, regardless
of the search or filter. Already-enabled products stay unchanged, while
unverified listings and protected pending corrections are skipped with a
reason. The result shows how many products were enabled, already enabled or
skipped. Products imported later still require explicit enrollment.

The app synchronizes products in bounded cross-product batches
instead of processing every product separately. Individual pause and
**Sync now** controls remain. If an unconfirmed stock correction spans multiple
products, pausing one participant prevents that correction from being retried
until the participants are verified and resumed; **Enable all** does not reset
it. Inventory synchronization still does not change retail prices,
descriptions or publication.

## 5. What is ready, and what remains

| Area | Current status |
|---|---|
| Catalog browsing and product selection | Working in the integration lab |
| Default and individual retail markup | Working in the integration lab |
| Reviewed imports and selected listing updates | Working in the integration lab |
| Large selection/review search and pagination | Working in the integration lab |
| Inventory correction, pause/resume and recovery | Verified with controlled lab stock tests |
| Enable-all inventory controls and cross-product batching | Available in the lab; verified by tests and read-only live checks |
| Source catalog image quality | Some products still require source-image repair |
| Independent retailer/store onboarding | Still to be completed beyond this lab store |
| Shopify order forwarding and tracking | Remaining implementation and end-to-end verification |
| Production dropshipping launch | Not enabled; requires separate approval and operational readiness |

The lab is for review and testing. It is not an approval to accept real customer
orders, take payments or dispatch shipments through the project.

## 6. Demonstration precautions and feedback

The lab is shared, and edits to selections, pricing, listings and stock persist.
For a first review, browse the app and existing results without changing them.
Coordinate with the project team before saving settings, confirming imports,
publishing products or enabling inventory sync.

Useful feedback includes:

- Is it clear how to choose products and set retail pricing?
- Are warnings, confirmation steps and recovery instructions understandable?
- Can you find a particular product easily in a large selection?
- What approval, shipping, payment, packaging, returns and tracking policies
  should apply before a real retailer pilot?

When reporting an issue, include the product name/SKU, the action taken and a
screenshot of the message. Do not share passwords, login codes or full
authentication URLs.
