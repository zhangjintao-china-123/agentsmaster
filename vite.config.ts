import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5174,
    proxy: {
      "/ws": { target: "http://127.0.0.1:8787", ws: true },
      "/health": "http://127.0.0.1:8787",
      "/setup": "http://127.0.0.1:8787",
      "/api": "http://127.0.0.1:8787",
    },
  },
});
