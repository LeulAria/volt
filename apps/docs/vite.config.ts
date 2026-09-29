import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import mdx from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";

const SILENT_WARNINGS = new Set([
  "MODULE_LEVEL_DIRECTIVE",
  // Nitro's defaults
  "EVAL",
  "CIRCULAR_DEPENDENCY",
  "THIS_IS_UNDEFINED",
  "EMPTY_BUNDLE",
]);

export default defineConfig({
  server: {
    port: 3000,
  },
  plugins: [
    mdx(await import("./source.config")),
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
        prerender: {
          enabled: true,
          crawlLinks: true,
        },
      },

      pages: [
        {
          path: "/docs",
        },
        {
          path: "/api/search",
        },
        {
          path: "llms-full.txt",
        },
        {
          path: "llms.txt",
        },
      ],
    }),
    react(),
    // please see https://tanstack.com/start/latest/docs/framework/react/guide/hosting#nitro for guides on hosting
    // Bundle tslib. Node resolves its "import" condition to modules/index.js, which Nitro's
    // tracer does not copy, so prerender crashes with ERR_MODULE_NOT_FOUND.
    nitro({
      noExternals: ["tslib"],
      rolldownConfig: {
        // The server bundle pulls in framer-motion, Radix, and next-themes, which all start with
        // `"use client"`. That directive means nothing on the server, so rolldown's notice about
        // dropping it is noise. This replaces Nitro's handler, so its own ignore list is kept.
        onwarn(warning, warn) {
          if (SILENT_WARNINGS.has(warning.code ?? "")) return;
          warn(warning);
        },
      },
    }),
  ],
  resolve: {
    tsconfigPaths: true,
    alias: {
      tslib: "tslib/tslib.es6.js",
    },
  },
});
