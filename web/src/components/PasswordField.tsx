/**
 * Booking password: type your own, or generate a strong one.
 *
 * This password is the *only* thing standing between a booking and anyone else
 * cancelling it (the appliance has no accounts), and it is shown exactly once
 * at creation — so it is worth being explicit rather than silently generating
 * one behind the user's back. Someone who wants a memorable password they can
 * share with a colleague should be able to set it; everyone else should get
 * something strong without thinking about it.
 *
 * Generation is client-side via `crypto.getRandomValues` rather than asking
 * the relay, so the password exists in exactly one place until the booking is
 * submitted.
 */

import { useState } from "react";

/** URL-safe alphabet: unambiguous when read aloud or copied out of a chat. */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(length = 16): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Minimum the relay will accept. */
  minLength?: number;
}

export function PasswordField({ value, onChange, minLength = 4 }: Props) {
  const [reveal, setReveal] = useState(false);
  const tooShort = value.length > 0 && value.length < minLength;

  return (
    <>
      <div className="mt-3 flex items-baseline justify-between">
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
          Cancellation password
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              onChange(generatePassword());
              setReveal(true);
            }}
            className="text-[11px] font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline dark:text-slate-400 dark:hover:text-slate-100"
          >
            Generate
          </button>
          {value && (
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              className="text-[11px] font-medium text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
            >
              {reveal ? "Hide" : "Show"}
            </button>
          )}
        </div>
      </div>
      <input
        type={reveal ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={64}
        placeholder="Choose one, or generate"
        autoComplete="new-password"
        spellCheck={false}
        className={
          "mt-1 w-full rounded-md border bg-white px-2.5 py-1.5 font-mono text-sm text-slate-800 outline-none focus:border-slate-500 dark:bg-slate-800 dark:text-slate-100 " +
          (tooShort
            ? "border-rose-400 dark:border-rose-500"
            : "border-slate-300 dark:border-slate-600")
        }
      />
      <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
        {tooShort
          ? `At least ${minLength} characters.`
          : "Needed to change or cancel this booking later. Saved in this browser, and shown once after booking."}
      </p>
    </>
  );
}
