import { defineConfig } from "vite";

export default defineConfig({
  base: "/academy-management-system/",
  build: {
    sourcemap: false,
    target: "es2022",
  },
});
