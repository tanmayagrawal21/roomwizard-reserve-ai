/**
 * The host's name, remembered locally so it isn't retyped for every booking —
 * one of the concrete things the appliance's own form gets wrong (PLAN.md).
 */

const KEY = "profile";

export interface Profile {
  firstName: string;
  lastName: string;
  /** Optional, remembered the same way as the name. See BookingModal for why. */
  email: string;
}

export function getProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { firstName: "", lastName: "", email: "" };
    const parsed = JSON.parse(raw) as Partial<Profile>;
    return {
      firstName: parsed.firstName ?? "",
      lastName: parsed.lastName ?? "",
      email: parsed.email ?? "",
    };
  } catch {
    return { firstName: "", lastName: "", email: "" };
  }
}

export function saveProfile(profile: Profile): void {
  localStorage.setItem(KEY, JSON.stringify(profile));
}
