import { createServer } from "vite";

// Offline browser harness: all server imports and Shopify calls are synthetic.
const state = `
import { retailPrice } from "/app/pricing-policy.ts";
export const shop = "ultralove-integration-lab.myshopify.com";
export let saved = {selected:[100], markup:"25.00", markups:{}};
export const jobs = [];
export function save(input) { saved = {...saved, selected:JSON.parse(input.productIds), markup:input.markup, markups:JSON.parse(input.markups)}; }
export const products = [100,200,300].map(id=>({id,name:"Fixture product "+id,type:"simple",sku:"SKU-"+id,price:"12.50",images:[],stock_status:"instock",stock_quantity:10}));
export function screen(id) {
  const job = jobs.find(job=>job.id===id)||null;
  return {...saved,job,history:jobs.map(job=>({...job,completed:job.items.filter(item=>item.status==="CREATED").length,total:job.items.length}))};
}
export function preview(markup, choices, configuration) {
  const ids = configuration?.ids||saved.selected;
  const markups = configuration?.markups||{};
  saved = {selected:ids,markup,markups};
  const id = String(jobs.length+1).padStart(32,"a");
  jobs.unshift({id,status:"PREVIEW",markup,markups,createdAt:new Date().toISOString(),active:choices.active,publicationId:choices.publish?"gid://shopify/Publication/10":null,
    confirmation:choices.publish?"publish-online-store":choices.active?"active-unpublished":"draft-only",generation:"offline",cursor:1,error:null,
    items:ids.map(supplierId=>({supplierId,name:"Fixture product "+supplierId,sku:"SKU-"+supplierId,status:"PREVIEW",markup:markups[supplierId]??markup,
      productId:null,error:null,attempts:0,wholesale:"12.50 CAD",retail:retailPrice("12.50",markups[supplierId]??markup)+" CAD",variantCount:1,warnings:[]}))});
  return jobs[0];
}
export function queue(id, retry, confirmation) {
  const job=jobs.find(job=>job.id===id);
  if(!job||confirmation!==job.confirmation)throw new Error("Confirm the immutable snapshot");
  job.status="QUEUED";
  setTimeout(()=>{
    job.status=retry?"COMPLETE":"FAILED";
    job.error=retry?null:"Simulated offline worker interruption: retry safely reconciles this snapshot.";
    job.items.forEach(item=>{item.status=retry?"CREATED":"FAILED";item.error=job.error;item.productId=retry?"gid://shopify/Product/"+item.supplierId:null;});
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
        import {createBrowserRouter,RouterProvider} from "react-router";
        import Index,{loader,action} from "/app/routes/app._index.tsx";
        import "/app/catalog.css";
        createRoot(document.getElementById("root")).render(React.createElement(RouterProvider,{router:createBrowserRouter([{path:"/app",Component:Index,loader,action}])}));`;
      if (id.endsWith("/app/shopify.server.ts")) return `import {shop} from "virtual:ux-state";export const authenticateLabAdmin=async()=>({session:{shop},admin:{graphql:async()=>{throw new Error("Live Shopify API disabled in fixture");}}});`;
      if (id.endsWith("/app/db.server.ts")) return `import {save} from "virtual:ux-state";export default {catalogSelection:{upsert:async input=>save(input.update)}};`;
      if (id.endsWith("/app/imports.server.ts")) return `import {screen,preview,queue} from "virtual:ux-state";
        export const importScreen=async(shop,id)=>screen(id);
        export const createPreview=async(shop,markup,api,choices,configuration)=>preview(markup,choices,configuration);
        export const queueJob=async(shop,id,retry,confirmation)=>queue(id,retry,confirmation);`;
      if (id.endsWith("/app/catalog.server.ts")) return `import {products} from "virtual:ux-state";
        export class CatalogError extends Error {}
        export async function validateSelection(){}
        export async function productsPage(filters){let rows=products.filter(p=>!filters.search||p.name.includes(filters.search));if(filters.after_id)rows=rows.filter(p=>p.id>filters.after_id);return {products:rows.slice(0,2),has_more:rows.length>2,next_after_id:rows[1]?.id};}
        export async function categoriesPage(){return {categories:[{id:1,name:"Fixture category"}],has_more:false};}`;
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!/^\/app(?:\?|$)/.test(req.url || "")) return next();
        const html = await server.transformIndexHtml(req.url, `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline unified import fixture</title><script src="https://cdn.shopify.com/shopifycloud/polaris.js"></script></head><body><div id="root"></div><script type="module" src="/ux-entry.jsx"></script></body></html>`);
        res.setHeader("Content-Type", "text/html"); res.end(html);
      });
    },
  }],
});
await server.listen();
console.log("Offline UX fixture: http://127.0.0.1:4179/app?shop=ultralove-integration-lab.myshopify.com&host=offline&embedded=1");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await server.close(); process.exit(0); });
