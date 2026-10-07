/**
 * Parsing for the Struts-rendered HTML forms (`BookingForm.action` and its
 * siblings in the create/delete flow).
 *
 * The appliance round-trips state through hidden form fields rather than a
 * session object, so every POST in a flow has to carry forward the *entire*
 * form the previous response rendered, with only the handful of fields we
 * care about overridden. Submitting a partial body is not tolerated — see
 * PLAN.md section 2. This module exists to make that round-trip boring: parse
 * everything once, let the caller override a few keys, re-encode.
 */

export type FormFields = Record<string, string>;

/**
 * Extract every `<input>` (except radios, which need explicit intent — see
 * below) and every `<select>`'s chosen value from a rendered form page.
 *
 * Radios are skipped deliberately. The two radio groups on this form
 * (`repeatType`, `durationType`) encode a real choice with no "current value"
 * to preserve — the appliance just omits the field entirely if none of a
 * group's inputs happen to carry a pre-checked `checked` attribute in the raw
 * HTML, which regex parsing can't reliably distinguish from "not present at
 * all". Callers must set these explicitly; `BOOKING_DEFAULTS` below does.
 */
export function parseFormFields(html: string): FormFields {
  const fields: FormFields = {};

  for (const m of html.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = m[1]!;
    const type = /\btype\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? "text";
    if (type.toLowerCase() === "radio") continue;
    const name = /\bname\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    if (!name) continue;
    const value = /\bvalue\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? "";
    fields[name] = decodeEntities(value);
  }

  for (const m of html.matchAll(/<select\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi)) {
    const name = m[1]!;
    const body = m[2]!;
    const selected = /<option\s+value="([^"]*)"[^>]*\bselected\b/i.exec(body);
    const first = /<option\s+value="([^"]*)"/i.exec(body);
    fields[name] = decodeEntities((selected ?? first)?.[1] ?? "");
  }

  return fields;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Fields with no "current value" to inherit — see `parseFormFields`. A new,
 * one-off (non-recurring) booking is the only case Phase 3 supports.
 */
export const BOOKING_DEFAULTS: FormFields = {
  repeatType: "none",
  durationType: "for",
};

/**
 * Diagnostic text from a form the appliance re-rendered instead of accepting.
 * `error` is a hidden field Struts sometimes populates directly; `errorMsgDiv2`
 * is populated client-side by the form's own JS validation and never reaches
 * the server, but the client-rendered strings it would have shown live in the
 * message catalogue the page also ships, which we are not parsing — so this
 * only catches the server-side case. Good enough for surfacing *that*
 * something was rejected; the HTTP flow in `booking.ts` is what decides
 * success or failure structurally, via the redirect.
 */
export function extractFormError(fields: FormFields): string | null {
  const err = fields.error?.trim();
  return err ? err : null;
}
