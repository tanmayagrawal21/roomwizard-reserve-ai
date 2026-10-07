/**
 * TLS plumbing for talking to the RoomWizard appliances.
 *
 * The appliances run Jetty 8 (2013) and support only TLS 1.2 with no ECDHE
 * suites at all. They offer DHE-RSA-AES128-GCM-SHA256, whose DH parameters are
 * below the floor OpenSSL 3 enforces by default, plus legacy AES128-SHA static
 * RSA. A default Node client therefore fails outright:
 *
 *     Error: ERR_SSL_DH_KEY_TOO_SMALL
 *
 * Setting @SECLEVEL=0 re-enables the small-DH suite. Measured against
 * bsrl-203.arizona.edu on Node 26 / OpenSSL 3.6.5, this negotiates
 * TLSv1.2 DHE-RSA-AES128-GCM-SHA256 — AEAD with forward secrecy, which is a
 * better outcome than pinning the static-RSA suite.
 *
 * Two things we deliberately do NOT do:
 *
 *   1. Disable certificate verification. The appliances carry real certs
 *      (CN=bsrl-NNN.arizona.edu, issued by InCommon/Internet2) that validate
 *      against Node's bundled CA store, so `rejectUnauthorized` stays on.
 *   2. Weaken TLS globally. The agent below is only ever used for appliance
 *      hosts; see `assertApplianceUrl`.
 */

import { Agent } from "undici";
import { APPLIANCE_HOST_SUFFIX, APPLIANCE_TIMEOUT_MS } from "./config.ts";

/**
 * OpenSSL cipher string. SECLEVEL=0 lifts the minimum-strength check that
 * rejects the appliances' DH group; it does not disable certificate checking.
 */
const APPLIANCE_CIPHERS = "DEFAULT:@SECLEVEL=0";

export const applianceAgent = new Agent({
  connect: {
    ciphers: APPLIANCE_CIPHERS,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
    rejectUnauthorized: true,
  },
  headersTimeout: APPLIANCE_TIMEOUT_MS,
  bodyTimeout: APPLIANCE_TIMEOUT_MS,
  // These boxes are single-threaded and ancient; one connection each is plenty.
  connections: 2,
});

/**
 * Guard against the permissive agent being pointed anywhere unintended — for
 * example by a room host injected through config, or a redirect we followed.
 */
export function assertApplianceUrl(url: string | URL): URL {
  const u = url instanceof URL ? url : new URL(url);
  if (u.protocol !== "https:") {
    throw new Error(`Refusing non-HTTPS appliance URL: ${u.href}`);
  }
  if (!u.hostname.endsWith(APPLIANCE_HOST_SUFFIX)) {
    throw new Error(
      `Refusing to use the permissive TLS agent for ${u.hostname} ` +
        `(expected a host under ${APPLIANCE_HOST_SUFFIX})`,
    );
  }
  return u;
}
