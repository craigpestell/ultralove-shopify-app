import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("catalog thumbnails are lazy, accessible, and cannot submit the selection form", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: "custom" });
  try {
    const { default: ProductImage } = await server.ssrLoadModule("/app/product-image.tsx");
    const html = renderToStaticMarkup(createElement(ProductImage, {
      name: "Cream &amp; Lotion",
      image: { src: "https://example.com/product.jpg", alt: "Product image" },
    }));
    assert.match(html, /type="button"/);
    assert.match(html, /aria-label="Show larger image of Cream &amp; Lotion"/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /width="48" height="48" loading="lazy"/);
    assert.match(html, /popover="auto"/);
    assert.equal((html.match(/<img /g) || []).length, 1, "larger image loads only when opened");
    for (const image of [undefined, { src: "", alt: "" }]) {
      const missing = renderToStaticMarkup(createElement(ProductImage, { name: "No photo", image }));
      assert.match(missing, /No image/);
      assert.doesNotMatch(missing, /<button|<img/);
    }
  } finally {
    await server.close();
  }
});
