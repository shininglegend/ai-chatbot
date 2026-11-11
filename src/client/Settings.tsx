import { useState } from "react";
import { type Defaults, EFFORTS, type Effort, MAX_PROFILE_CHARS, type ModelList, TTL_PRESETS } from "../shared";

type Props = {
  profile: string;
  defaults: Defaults;
  modelList: ModelList;
  place: string | null;
  onSave: (profile: string, defaults: Defaults) => Promise<unknown>;
  onClose: () => void;
};

const selectClass =
  "rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700";

export function Settings({ profile, defaults, modelList, place, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(profile);
  const [chosen, setChosen] = useState(defaults);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<Defaults>) => setChosen((current) => ({ ...current, ...patch }));
  // A saved default model that is no longer offered falls back to "first on the list".
  const modelId = modelList.models.some((model) => model.id === chosen.modelId) ? chosen.modelId : null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft, { ...chosen, modelId });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="flex max-h-full w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-xl bg-white p-4 dark:bg-neutral-900"
      >
        <h2 id="settings-title" className="text-base font-medium">
          Settings
        </h2>

        <label className="flex flex-col gap-1.5 text-sm">
          About me
          <textarea
            className="min-h-40 rounded-lg border border-neutral-300 bg-transparent p-2 text-base outline-none focus:border-neutral-500 dark:border-neutral-700"
            maxLength={MAX_PROFILE_CHARS}
            placeholder="Who you are and anything the model should keep in mind: diet, household, home city, units…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>

        <div className="space-y-1.5 text-xs text-neutral-500">
          <p>
            In chats with “Context” ticked, each message also gives the model this text, your local time and time
            zone, and your approximate location{place ? ` (currently ${place})` : " (currently unknown)"}. The location
            is Cloudflare’s guess from your network; it will be wrong on a VPN.
          </p>
          <p>
            All of it goes to the model provider with the message. This text is kept until you clear it here; it is not
            on any chat’s timer.
          </p>
        </div>

        <fieldset className="flex flex-col gap-2 border-t border-neutral-200 pt-3 text-sm dark:border-neutral-800">
          <legend className="float-left mb-1 w-full font-medium">New chats start with</legend>
          <label className="flex items-center justify-between gap-3">
            Model
            <select className={selectClass} value={modelId ?? ""} onChange={(event) => set({ modelId: event.target.value || null })}>
              <option value="">First on the list</option>
              {modelList.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-3">
            Effort
            <select
              className={selectClass}
              value={chosen.effort ?? ""}
              onChange={(event) => set({ effort: (event.target.value || null) as Effort | null })}
            >
              <option value="">The model’s default</option>
              {EFFORTS.map((effort) => (
                <option key={effort.value} value={effort.value}>
                  {effort.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-3">
            Delete after
            <select
              className={selectClass}
              value={chosen.ttl === null ? "never" : String(chosen.ttl)}
              onChange={(event) => set({ ttl: event.target.value === "never" ? null : Number(event.target.value) })}
            >
              {TTL_PRESETS.map((preset) => (
                <option key={preset.label} value={preset.seconds === null ? "never" : String(preset.seconds)}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-3">
            Context (About me, time, location)
            <input type="checkbox" checked={chosen.includeContext} onChange={(event) => set({ includeContext: event.target.checked })} />
          </label>
          <label className="flex items-center justify-between gap-3">
            Web search
            <input type="checkbox" checked={chosen.webSearch} onChange={(event) => set({ webSearch: event.target.checked })} />
          </label>
          <p className="text-xs text-neutral-500">Chats you already have keep their own settings.</p>
        </fieldset>

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-lg px-4 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
            disabled={saving}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
