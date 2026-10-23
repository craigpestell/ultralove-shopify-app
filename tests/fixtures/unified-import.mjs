import { createServer } from "vite";

// Offline browser harness: all server imports and Shopify calls are synthetic.
const state = `
import { retailPrice } from "/app/pricing-policy.ts";
import { defaultListingPolicy } from "/app/listing-policy.ts";
export const shop = "ultralove-integration-lab.myshopify.com";
export let saved = {selected:${JSON.stringify(process.env.UX_FIXTURE_LARGE_SELECTION ? Array.from({length: 300}, (_, index) => (index + 1) * 100) : [100])}, markup:"25.00", markups:{},fulfillmentModes:{}};
export const detailsControl = {fail:false,calls:[]};
export const jobs = [];
export function save(input) { saved = {...saved, selected:JSON.parse(input.productIds), markup:input.markup, markups:JSON.parse(input.markups),fulfillmentModes:JSON.parse(input.fulfillmentModes||"{}")}; }
export const products = Array.from({length:${process.env.UX_FIXTURE_LARGE_SELECTION ? 300 : 55}},(_,index)=>(index+1)*100).map(id=>({id,name:({"100":"Amber travel case","200":"Rose wellness kit","300":"Satin gift set"})[id]||"Fixture product "+id,type:id===300?"variable":"simple",sku:"SKU-"+id,price:"12.50",currency:"CAD",images:[],manage_stock:true,stock_owner_id:id,stock_quantity:10}));
export const inventory = ${process.env.UX_FIXTURE_LARGE_SELECTION ? "products.map(p=>p.id)" : "[100,200]"}.map(supplierId=>({supplierId,fulfillmentMode:supplierId===200?"CATALOG":"DROPSHIPPING",name:products.find(p=>p.id===supplierId).name,sku:"SKU-"+supplierId,productId:"gid://shopify/Product/"+supplierId,enabled:supplierId===100,status:supplierId===100?"SYNCED":supplierId===300?"REVIEW":"NOT_ENROLLED",variantCount:1,error:supplierId===300?"The linked Shopify product could not be found.":null,lastSuccessAt:supplierId===100?new Date().toISOString():null,nextRunAt:null}));
export const inventoryActions = [];
export function screen(id) {
  const job = jobs.find(job=>job.id===id)||null;
  return {...saved,job,history:jobs.map(job=>({...job,completed:job.items.filter(item=>["CREATED","REUSED","UPDATED","LINKED"].includes(item.status)).length,total:job.items.length}))};
}
export function preview(markup, choices, configuration, policy = defaultListingPolicy()) {
  const ids = configuration?.ids||saved.selected;
  const markups = configuration?.markups||{};
  const fulfillmentModes=configuration?.fulfillmentModes||{};
  saved = {selected:ids,markup,markups,fulfillmentModes};
  const id = String(jobs.length+1).padStart(32,"a");
  jobs.unshift({id,status:"PREVIEW",markup,markups,listingPolicy:policy,createdAt:new Date().toISOString(),active:choices.active,publicationId:choices.publish?"gid://shopify/Publication/10":null,
    confirmation:choices.publish?"publish-online-store":choices.active?"active-unpublished":"draft-only",generation:"offline",cursor:1,error:null,
    items:ids.map(supplierId=>{
      const action=policy.links[supplierId]?"LINK":policy.recreate.includes(supplierId)||supplierId===200?"RECREATE":supplierId===400?"BLOCKED":supplierId===100?policy.mode==="UPDATE"?"UPDATE":"KEEP":"CREATE";
      const targetId=policy.links[supplierId]||(supplierId===100?"gid://shopify/Product/100":null);
      const changes=[];
      if(policy.mode==="UPDATE"&&["UPDATE","LINK"].includes(action)){
        if(policy.content)changes.push({field:"Title",before:"Retailer-edited title",after:products.find(p=>p.id===supplierId)?.name||"Supplier title"});
        if(policy.prices)changes.push({field:"Retail price",before:"19.99 CAD",after:retailPrice("12.50",markups[supplierId]??markup)+" CAD"});
        if(policy.images)changes.push({field:"Supplier images",before:"1 existing image retained",after:"Add 1 supplier image"});
      }
      return {supplierId,fulfillmentMode:fulfillmentModes[supplierId]||"CATALOG",name:products.find(p=>p.id===supplierId)?.name||"Fixture product "+supplierId,sku:"SKU-"+supplierId,status:"PREVIEW",markup:markups[supplierId]??markup,
      productId:targetId,error:null,attempts:0,wholesale:"12.50 CAD",retail:retailPrice("12.50",markups[supplierId]??markup)+" CAD",variantCount:1,warnings:[],
      listing:{action,targetId,changes,message:action==="BLOCKED"?"The previously linked Shopify product still exists, but its UltraLove connection changed. Reconnect it instead of creating a replacement.":action==="RECREATE"?"The previously linked product is confirmed missing. Confirming this review will create a replacement using the reviewed prices and visibility settings.":null}};
    })});
  return jobs[0];
}
export function queue(id, retry, confirmation) {
  const job=jobs.find(job=>job.id===id);
  if(!job||confirmation!==job.confirmation)throw new Error("Confirm the immutable snapshot");
  if(job.items.some(item=>item.listing.action==="BLOCKED"))throw new Error("Resolve product connections before importing");
  job.status="QUEUED";
  setTimeout(()=>{
    job.status=retry?"COMPLETE":"FAILED";
    job.error=retry?null:"Simulated offline worker interruption: retry safely reconciles this snapshot.";
    job.items.forEach(item=>{item.status=retry?(item.listing.action==="UPDATE"?"UPDATED":item.listing.action==="LINK"?"LINKED":item.listing.action==="KEEP"?"REUSED":"CREATED"):"FAILED";item.error=job.error;item.productId=item.productId||(retry?"gid://shopify/Product/"+item.supplierId:null);});
  },100);
}
`;
const server = await createServer({
  configFile: false, appType: "custom", envDir: false,
  optimizeDeps: { include: ["react", "react-dom/client", "react-router"] },
  server: { host: "127.0.0.1", port: 4179, strictPort: true },
  plugins: [{
    name: "offline-ux-fixture", enforce: "pre",
    resolveId(id) {
      if (id === "virtual:ux-state") return "\0ux-state";
      if (id === "/ux-entry.jsx") return "\0ux-entry.jsx";
      if (id === "@shopify/shopify-app-react-router/server") return "\0ux-boundary";
    },
    load(id) {
      if (id === "\0ux-state") return state;
      if (id === "\0ux-boundary") return "export const boundary={error:()=>null,headers:()=>({})};";
      if (id === "\0ux-entry.jsx") return `
        import React from "react";
        import {createRoot} from "react-dom/client";
        import {createBrowserRouter,RouterProvider,Outlet,useLoaderData} from "react-router";
        import Index,{loader,action} from "/app/routes/app._index.tsx";
        import {loader as detailsLoader} from "/app/routes/app.selection-details.ts";
        import Inventory,{loader as inventoryLoader,action as inventoryAction} from "/app/routes/app.inventory.tsx";
        import {WorkspaceProvider} from "/app/workspace.tsx";
        import {saved,shop} from "virtual:ux-state";
        import "/app/catalog.css";
        function Workspace(){const data=useLoaderData();return React.createElement(WorkspaceProvider,{shop,saved:data.saved},React.createElement(Outlet));}
        createRoot(document.getElementById("root")).render(React.createElement(RouterProvider,{router:createBrowserRouter([{path:"/app",Component:Workspace,loader:async()=>({saved}),children:[{index:true,Component:Index,loader,action},{path:"selection-details",loader:detailsLoader},{path:"inventory",Component:Inventory,loader:inventoryLoader,action:inventoryAction}]}])}));`;
      if (id.endsWith("/app/shopify.server.ts")) return `import {shop} from "virtual:ux-state";export const authenticateRetailer=async()=>({session:{shop},admin:{graphql:async()=>{throw new Error("Live Shopify API disabled in fixture");}}});`;
      if (id.endsWith("/app/db.server.ts")) return `import {save} from "virtual:ux-state";export default {catalogSelection:{upsert:async input=>save(input.update)}};`;
      if (id.endsWith("/app/imports.server.ts")) return `import {screen,preview,queue} from "virtual:ux-state";
        export class ImportError extends Error {}
        export const savedConfiguration=async()=>screen(null);
        export const importScreen=async(shop,id)=>screen(id);
        export const createPreview=async(shop,markup,api,choices,configuration,policy)=>preview(markup,choices,configuration,policy);
        export const queueJob=async(shop,id,retry,confirmation)=>queue(id,retry,confirmation);`;
      if (id.endsWith("/app/inventory.server.ts")) return `import {inventory,inventoryActions} from "virtual:ux-state";
        import {InventoryError} from "/app/inventory-engine.ts";
        export const inventoryScreen=async()=>inventory;
        export async function enableAllInventory(shop,admin,confirm) {
          if(confirm!=="inventory-all-current")throw new InventoryError("Confirmation required");
          const result={total:inventory.length,enabled:0,alreadyEnabled:0,blocked:[],error:null};
          inventoryActions.push({intent:"enable-all",ids:inventory.map(p=>p.supplierId)});
          for(const product of inventory) {
            if(product.fulfillmentMode==="CATALOG"){result.blocked.push({...product,error:"Catalog only: your own stock is never eligible for supplier sync."});continue;}
            if(product.enabled){result.alreadyEnabled++;continue;}
            if(product.error){result.blocked.push({...product,error:product.error});continue;}
            product.enabled=true;product.status="QUEUED";result.enabled++;
          }
          return result;
        }
        export async function inventoryControl(shop,id,intent,admin,confirm){const product=inventory.find(p=>p.supplierId===id);if(!product)throw new Error("Unknown product");
          if(intent==="enable"&&confirm!=="inventory-only")throw new Error("Confirmation required");product.enabled=intent!=="pause";product.status=intent==="pause"?"PAUSED":"QUEUED";}`;
      if (id.endsWith("/app/catalog.server.ts")) return `import {products,detailsControl} from "virtual:ux-state";
        export class CatalogError extends Error {}
        export async function selectedProducts(ids){detailsControl.calls.push(ids);await new Promise(resolve=>setTimeout(resolve,50));if(detailsControl.fail)throw new CatalogError("Fixture supplier details unavailable");return products.filter(p=>ids.includes(p.id)).map(({id,name,sku,price,type})=>({id,name,sku,price,type}));}
        export async function validateSelection(){}
        export async function productsPage(filters){let rows=products.filter(p=>!filters.search||p.name.includes(filters.search));if(filters.after_id)rows=rows.filter(p=>p.id>filters.after_id);const page=rows.slice(0,50);return {products:page,has_more:rows.length>50,next_after_id:page.at(-1)?.id??filters.after_id??0};}
        export async function categoriesPage(){return {categories:[{id:1,name:"Fixture category"}],has_more:false};}`;
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!/^\/app(?:\/inventory)?(?:\?|$)/.test(req.url || "")) return next();
        const html = await server.transformIndexHtml(req.url, `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline task workspace fixture</title><script src="https://cdn.shopify.com/shopifycloud/polaris.js"></script></head><body><div id="root"></div><script type="module" src="/ux-entry.jsx"></script></body></html>`);
        res.setHeader("Content-Type", "text/html"); res.end(html);
      });
    },
  }],
});
await server.listen();
console.log("Offline UX fixture: http://127.0.0.1:4179/app?shop=ultralove-integration-lab.myshopify.com&host=offline&embedded=1");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await server.close(); process.exit(0); });
