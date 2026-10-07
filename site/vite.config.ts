import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base: "./"` keeps every emitted asset URL relative, so the site works
// both as a user/org page and as a project page under a /<repo>/ subpath.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
