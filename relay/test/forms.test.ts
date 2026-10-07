import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractFormError, parseFormFields } from "../src/forms.ts";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

describe("parseFormFields", () => {
  const fields = parseFormFields(fixture("booking-form.html"));

  it("captures hidden field values", () => {
    expect(fields.currentDate).toBe("20261007");
    expect(fields.display_date).toBe("20261008");
    expect(fields.booking_id).toBe("");
  });

  it("captures empty-value text inputs rather than dropping them", () => {
    expect(fields.purpose).toBe("");
    expect(fields.hostFirstName).toBe("");
  });

  it("captures password inputs", () => {
    expect(fields.password).toBe("");
    expect(fields.repeatPassword).toBe("");
  });

  it("picks the selected option from a select, not the first", () => {
    // "startTime" lists 070000 first but 180000 is marked selected.
    expect(fields.startTime).toBe("180000");
    expect(fields.endTime).toBe("190000");
  });

  it("falls back to the first option when nothing is marked selected", () => {
    const noSelection = parseFormFields(
      '<select name="x"><option value="a">A</option><option value="b">B</option></select>',
    );
    expect(noSelection.x).toBe("a");
  });

  it("does not capture radio inputs", () => {
    // repeatType/durationType are radios; callers must set these explicitly
    // via BOOKING_DEFAULTS rather than inherit a parsed value.
    expect(fields.repeatType).toBeUndefined();
    expect(fields.durationType).toBeUndefined();
  });

  it("decodes HTML entities in attribute values", () => {
    const withEntities = parseFormFields('<input name="x" value="O&#39;Brien &amp; Co" />');
    expect(withEntities.x).toBe("O'Brien & Co");
  });

  it("returns an empty object for input with no name", () => {
    expect(parseFormFields('<input type="text" value="orphan" />')).toEqual({});
  });
});

describe("extractFormError", () => {
  it("surfaces the appliance's error field when present", () => {
    const fields = parseFormFields(fixture("booking-form-with-error.html"));
    expect(extractFormError(fields)).toBe("This room is not available at the selected times.");
  });

  it("returns null when there is no error field", () => {
    const fields = parseFormFields(fixture("booking-form.html"));
    expect(extractFormError(fields)).toBeNull();
  });

  it("treats a blank error field as no error", () => {
    expect(extractFormError({ error: "   " })).toBeNull();
  });
});

describe("delete-flow fixtures", () => {
  it("reads showDeleteButton=true as password accepted", () => {
    const fields = parseFormFields(fixture("validate-password-accepted.html"));
    expect(fields.showDeleteButton).toBe("true");
    expect(fields.booking_id).toBe("4251");
  });

  it("reads showDeleteButton=false as password rejected", () => {
    const fields = parseFormFields(fixture("validate-password-rejected.html"));
    expect(fields.showDeleteButton).toBe("false");
  });

  it("reads an empty booking_id as 'no such booking'", () => {
    const fields = parseFormFields(fixture("booking-form-not-found.html"));
    expect(fields.booking_id).toBe("");
  });
});
