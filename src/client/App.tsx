import { useAgent } from "agents/react";
import { useCallback, useEffect, useState } from "react";
import { BUILT_IN_DEFAULTS, type ChatOptions, type HubState, type Me, type ModelList, NEW_CHAT_TITLE } from "../shared";
import { Chat } from "./Chat";
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

  // The approximate place comes from the network, so look again when the app is reopened
  // (a phone tab can stay open across a trip).
  const [place, setPlace] = useState(me.place);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      fetch("/api/me")
        .then((res) => (res.ok ? (res.json() as Promise<Me>) : null))
        .then((fresh) => fresh && setPlace(fresh.place))
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    setSidebarOpen(false);
    // The fragment is never sent to the server; it only lets a reload reopen the same chat.
    history.replaceState(null, "", id ? `#${id}` : location.pathname);
  }, []);

  const selected = chats?.find((chat) => chat.id === selectedId) ?? null;

  // The open chat was deleted (timer ran out, or deleted from another tab).
  useEffect(() => {
    if (chats && selectedId && !selected) select(null);
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

  const deleteChat = (id: string) => run(() => hub.call("deleteChat", [id]));
  const deleteAll = () => run(() => hub.call("deleteAll"));
  const setTtl = (id: string, ttl: number | null) => run(() => hub.call("setTtl", [id, ttl]));
  const setOptions = (id: string, patch: Partial<ChatOptions>) => run(() => hub.call("setChatOptions", [id, patch]));

  return (
    <div className="flex h-full">
      <Sidebar
        me={me}
        chats={chats ?? []}
        selectedId={selectedId}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
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
      <main className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div role="alert" className="bg-red-600 px-4 py-2 text-sm text-white">
            {error}
          </div>
        )}
        {selected ? (
          <Chat
            key={selected.id}
            hubKey={me.key}
            chat={selected}
            place={place}
            modelList={modelList}
            onSetOptions={(patch) => setOptions(selected.id, patch)}
            onOpenSidebar={() => setSidebarOpen(true)}
            onSetTtl={(ttl) => setTtl(selected.id, ttl)}
            onDelete={() => deleteChat(selected.id)}
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
