import { defineConfig } from "@playwright/test";
import base from "./runtime-services.config";

export default defineConfig({ ...base, testMatch: "runtime-service-experimental.spec.ts" });
