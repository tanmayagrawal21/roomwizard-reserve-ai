/**
 * The host's name, remembered locally so it isn't retyped for every booking —
 * one of the concrete things the appliance's own form gets wrong (PLAN.md).
 */

const KEY = "profile";

export interface Profile {
  firstName: string;
  lastName: string;
}

export function getProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { firstName: "", lastName: "" };
    const parsed = JSON.parse(raw) as Partial<Profile>;
    return { firstName: parsed.firstName ?? "", lastName: parsed.lastName ?? "" };
  } catch {
    return { firstName: "", lastName: "" };
  }
}

export function saveProfile(profile: Profile): void {
  localStorage.setItem(KEY, JSON.stringify(profile));
}
