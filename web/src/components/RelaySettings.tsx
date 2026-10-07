import { useState } from "react";
import { getRelayUrl, setRelayUrl } from "../api";

/**
 * The relay's address can't be baked into a static bundle, because it lives on
 * the building's network and differs per deployment. This lets someone point
 * the hosted UI at their own relay without a rebuild.
 */
export function RelaySettings({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState(getRelayUrl());

  const save = () => {
    setRelayUrl(value);
    // A full reload is the honest way to reset every cached query and
    // in-flight request against the old origin.
    window.location.reload();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-24 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Relay address
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          The relay is the small service that talks to the room appliances. It has to run
          on the building's network, so this page can only reach it when you are on that
          network or its VPN.
        </p>
        <input
          type="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") onClose();
          }}
          placeholder="http://localhost:8787"
          spellCheck={false}
          autoFocus
          className="mt-3 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-800 outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
          >
            Save and reload
          </button>
        </div>
      </div>
    </div>
  );
}
