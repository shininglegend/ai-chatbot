import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BUILT_IN_DEFAULTS, type ChatOptions, type HubState, type Me, type ModelList, NEW_CHAT_TITLE } from "../shared";
import { Chat, type Draft } from "./Chat";
import { Settings } from "./Settings";
import { Sidebar } from "./Sidebar";

function chatIdFromHash(): string | null {
  return location.hash.slice(1) || null;
}

export function App({ me, modelList }: { me: Me; modelList: ModelList }) {
  const hub = useAgent<HubState>({ agent: "UserHub", name: me.key });
  const chats = hub.state?.chats;
  const [selectedId, setSelectedId] = useState<string | null>(chatIdFromHash);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Shown when the open chat went away on its own (its timer ran out, or another tab deleted it). */
  const [notice, setNotice] = useState<string | null>(null);
  /** Unsent text and attachments per chat, kept in memory only so switching chats does not lose them. */
  const drafts = useRef(new Map<string, Draft>());
  /** Option changes sent to the hub but not yet confirmed, per chat, shown in the meantime. */
  const [pendingOptions, setPendingOptions] = useState<Record<string, Partial<ChatOptions>>>({});
  /** Chats this tab asked to delete, so their disappearance is not reported as a surprise. */
  const deletedHere = useRef(new Set<string>());

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  // The slide-over list only exists below the md breakpoint; close it if the window grows past that.
  useEffect(() => {
    const wide = matchMedia("(min-width: 768px)");
    const onChange = () => wide.matches && setSidebarOpen(false);
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, []);

  // The approximate place comes from the network, so look again when the app is reopened
  // (a phone tab can stay open across a trip).
  const [place, setPlace] = useState(me.place);
  const [coords, setCoords] = useState(me.coords);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      fetch("/api/me")
        .then((res) => (res.ok ? (res.json() as Promise<Me>) : null))
        .then((fresh) => {
          if (!fresh) return;
          setPlace(fresh.place);
          setCoords(fresh.coords ?? null);
        })
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    setNotice(null);
    setSidebarOpen(false);
    // The fragment is never sent to the server; it only lets a reload reopen the same chat.
    history.replaceState(null, "", id ? `#${id}` : location.pathname);
  }, []);

  const selected = chats?.find((chat) => chat.id === selectedId) ?? null;

  // The open chat was deleted (timer ran out, or deleted from another tab).
  useEffect(() => {
    if (!chats || !selectedId || selected) return;
    const expected = deletedHere.current.delete(selectedId);
    drafts.current.delete(selectedId);
    select(null);
    if (!expected) setNotice("That chat was deleted: its timer ran out, or it was deleted in another window.");
  }, [chats, selectedId, selected, select]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong");
    }
  }, []);

  const newChat = () =>
    run(async () => {
      // Reuse an untouched chat instead of piling up empty ones.
      const empty = chats?.find((chat) => chat.title === NEW_CHAT_TITLE);
      select(empty?.id ?? (await hub.call<string>("createChat")));
    });

  const deleteChat = (id: string) => {
    deletedHere.current.add(id);
    drafts.current.delete(id);
    return run(() => hub.call("deleteChat", [id]));
  };
  const deleteAll = () => {
    for (const chat of chats ?? []) deletedHere.current.add(chat.id);
    drafts.current.clear();
    return run(() => hub.call("deleteAll"));
  };
  const restartTimer = (id: string) => run(() => hub.call("restartTimer", [id]));
  const setTtl = (id: string, ttl: number | null) => {
    // A timer that has already run out deletes the chat; the user confirmed that, so it is expected.
    const chat = chats?.find((c) => c.id === id);
    if (chat && ttl !== null && chat.lastActivity + ttl * 1000 <= Date.now()) deletedHere.current.add(id);
    return run(() => hub.call("setTtl", [id, ttl]));
  };
  const setOptions = async (id: string, patch: Partial<ChatOptions>) => {
    // Show the change at once rather than after the hub's round trip. Once the call settles the
    // hub's state is the truth again: the new value when it was saved, the old one if it failed.
    setPendingOptions((all) => ({ ...all, [id]: { ...all[id], ...patch } }));
    await run(() => hub.call("setChatOptions", [id, patch]));
    setPendingOptions((all) => {
      const rest: Partial<ChatOptions> = { ...all[id] };
      // A newer change to the same option is still on its way; keep showing that one.
      for (const key of Object.keys(patch) as (keyof ChatOptions)[]) {
        if (rest[key] === patch[key]) delete rest[key];
      }
      const { [id]: _done, ...others } = all;
      return Object.keys(rest).length > 0 ? { ...others, [id]: rest } : others;
    });
  };

  return (
    <div className="flex h-full">
      <Sidebar
        me={me}
        chats={chats ?? []}
        selectedId={selectedId}
        open={sidebarOpen}
        onClose={closeSidebar}
        onSelect={select}
        onNew={newChat}
        onDelete={deleteChat}
        onDeleteAll={deleteAll}
        spend={hub.state?.spend ?? null}
        onOpenSettings={() => {
          setSidebarOpen(false);
          setSettingsOpen(true);
        }}
      />
      {settingsOpen && (
        <Settings
          profile={hub.state?.profile ?? ""}
          defaults={{ ...BUILT_IN_DEFAULTS, ...hub.state?.defaults }}
          modelList={modelList}
          place={place}
          onSave={async (profile, defaults) => {
            await hub.call("setProfile", [profile]);
            await hub.call("setDefaults", [defaults]);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <main className="flex min-w-0 flex-1 flex-col" inert={sidebarOpen}>
        {error && (
          <div role="alert" className="flex items-start gap-3 bg-red-600 px-4 py-2 text-sm text-white">
            <p className="flex-1">{error}</p>
            <button type="button" aria-label="Dismiss" className="-my-1 rounded px-2 py-1 hover:bg-red-700" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        )}
        {notice && (
          <div role="status" className="flex items-start gap-3 bg-neutral-100 px-4 py-2 text-sm dark:bg-neutral-900">
            <p className="flex-1">{notice}</p>
            <button
              type="button"
              aria-label="Dismiss"
              className="-my-1 rounded px-2 py-1 hover:bg-neutral-200 dark:hover:bg-neutral-800"
              onClick={() => setNotice(null)}
            >
              ×
            </button>
          </div>
        )}
        {selected ? (
          <Chat
            key={selected.id}
            hubKey={me.key}
            chat={{ ...selected, ...pendingOptions[selected.id] }}
            place={place}
            coords={coords}
            modelList={modelList}
            onSetOptions={(patch) => setOptions(selected.id, patch)}
            onOpenSidebar={() => setSidebarOpen(true)}
            onNew={newChat}
            onSetTtl={(ttl) => setTtl(selected.id, ttl)}
            onRestartTimer={() => restartTimer(selected.id)}
            onDelete={() => deleteChat(selected.id)}
            initialDraft={drafts.current.get(selected.id)}
            onDraftChange={(draft) => {
              if (draft.text || draft.files.length > 0) drafts.current.set(selected.id, draft);
              else drafts.current.delete(selected.id);
            }}
          />
        ) : (
          <div className="flex flex-1 flex-col">
            <header className="flex items-center border-b border-neutral-200 p-2 md:hidden dark:border-neutral-800">
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
                onClick={() => setSidebarOpen(true)}
              >
                Chats
              </button>
            </header>
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
              <p className="max-w-sm text-sm text-neutral-500">
                Chats delete themselves 3 hours after the last message unless you change the timer.
              </p>
              <button
                type="button"
                className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
                disabled={!chats}
                onClick={newChat}
              >
                New chat
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
