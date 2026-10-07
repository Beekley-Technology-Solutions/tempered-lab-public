import { buildApp } from "../lib/app.js";
import { loadConfig } from "../lib/config.js";

// Identifiers come from TL_* environment variables (lib/config.ts, ADR 0004).
buildApp(loadConfig());
