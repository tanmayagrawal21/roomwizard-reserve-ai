import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import {
  ALLOWED_ORIGINS,
  APPLIANCE_HOST_SUFFIX,
  PORT,
  ROSTER_HOST,
  SITE_NAME,
  TIMEZONE,
} from "./config.ts";

const app = createApp();

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`RoomWizard relay for ${SITE_NAME} on http://localhost:${info.port}`);
  console.log(`  roster host     ${ROSTER_HOST}`);
  console.log(`  timezone        ${TIMEZONE}`);
  console.log(`  TLS exception   *${APPLIANCE_HOST_SUFFIX}`);
  console.log(`  allowed origins ${ALLOWED_ORIGINS.join(", ") || "(none)"}`);
  console.log(
    "  note: appliances are on private campus addresses; this process must run on the\n" +
      "        building's network or VPN",
  );
});
