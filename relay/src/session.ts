/**
 * A short-lived cookie-carrying session against one appliance.
 *
 * The booking and cancellation flows are each a chain of 2-4 requests that
 * must share a `JSESSIONID` — the appliance tracks the in-progress form
 * server-side, not just in the hidden fields it renders. `fetch`/undici don't
 * carry cookies across calls automatically, so this is the smallest thing that
 * does.
 *
 * Redirects are never followed automatically: a 302 to `GroupView.action` is
 * how the appliance spells "accepted", so the caller needs to see the status
 * code and `Location` header directly rather than have them disappear into an
 * automatically-followed hop.
 */

import { request } from "undici";
import { APPLIANCE_TIMEOUT_MS } from "./config.ts";
import { applianceAgent, assertApplianceUrl } from "./tls.ts";
import { ApplianceError } from "./roomwizard.ts";
import type { FormFields } from "./forms.ts";

export interface ApplianceResponse {
  status: number;
  location: string | null;
  body: string;
}

export class ApplianceSession {
  readonly #host: string;
  readonly #cookies = new Map<string, string>();

  constructor(host: string) {
    this.#host = host;
  }

  #cookieHeader(): string | undefined {
    if (this.#cookies.size === 0) return undefined;
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  #captureCookies(setCookie: string | string[] | undefined): void {
    if (!setCookie) return;
    for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const [pair] = line.split(";", 1);
      const eq = pair!.indexOf("=");
      if (eq <= 0) continue;
      this.#cookies.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
    }
  }

  async get(path: string, params?: Record<string, string>): Promise<ApplianceResponse> {
    const url = new URL(path, this.#host);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    return this.#send(url, "GET");
  }

  async postForm(path: string, fields: FormFields): Promise<ApplianceResponse> {
    const url = new URL(path, this.#host);
    const body = new URLSearchParams(fields).toString();
    return this.#send(url, "POST", body);
  }

  async #send(url: URL, method: "GET" | "POST", body?: string): Promise<ApplianceResponse> {
    assertApplianceUrl(url);
    const signal = AbortSignal.timeout(APPLIANCE_TIMEOUT_MS);
    try {
      // undici's request() does not follow redirects unless an interceptor is
      // configured, which applianceAgent is not — so a 302 always comes back
      // as a 302 here, which is exactly what the booking flow needs to see.
      const res = await request(url, {
        method,
        dispatcher: applianceAgent,
        signal,
        headers: {
          accept: "text/html,*/*",
          ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(this.#cookieHeader() ? { cookie: this.#cookieHeader()! } : {}),
        },
        body,
      });
      this.#captureCookies(res.headers["set-cookie"]);
      const text = await res.body.text();
      const location = res.headers.location;
      return {
        status: res.statusCode,
        location: typeof location === "string" ? location : null,
        body: text,
      };
    } catch (err) {
      throw new ApplianceError(`${method} ${url.pathname} failed`, this.#host, err);
    }
  }
}
