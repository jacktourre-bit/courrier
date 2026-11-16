import { serve } from "@hono/node-server";
import { createApi } from "./api/app.js";
import { hs256Authenticator } from "./api/auth.js";
import { depsFromEnv } from "./bootstrap.js";

const deps = depsFromEnv();
const secret = process.env.POSTAL_JWT_SECRET;
if (!secret) throw new Error("POSTAL_JWT_SECRET requis (ou brancher l'Authenticator de l'application hôte)");
const app = createApi({ deps, auth: hs256Authenticator(secret, { issuer: process.env.POSTAL_JWT_ISSUER ?? "saas", audience: "postal" }) });
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
deps.logger.info("api.started", { port, flags: deps.config.flags });
