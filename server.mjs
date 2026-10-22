import express from "express";
import { createRequestHandler } from "@react-router/express";
import * as build from "./build/server/index.js";

const app = express();
app.disable("x-powered-by");
app.use((request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  response.on("finish", () => {
    console.info(`${request.method} ${request.path} ${response.statusCode}`);
  });
  next();
});
app.use(express.static("build/client", { index: false }));
app.all("/{*splat}", createRequestHandler({ build, mode: process.env.NODE_ENV }));
app.listen(Number(process.env.PORT || 3097), process.env.HOST || "127.0.0.1", () => {
  console.info("UltraLove Shopify interface listening.");
});
