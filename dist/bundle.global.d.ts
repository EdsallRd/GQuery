import * as GQueryModule from "./bundle.js";

declare global {
  const GQuery: typeof GQueryModule.createGQuery & typeof GQueryModule;
}

export {};
