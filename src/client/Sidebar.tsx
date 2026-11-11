import type { ChatSummary, Me, Spend } from "../shared";
import { formatUsd } from "./format";
import { timeLeft, useNow } from "./time";

type Props = {
  me: Me;
  chats: ChatSummary[];
  selectedId: string | null;
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onDeleteAll: () => void;
  onOpenSettings: () => void;
  /** Estimated model spend this month; null until the hub has connected. */
  spend: Spend | null;
};

export function Sidebar({ me, chats, selectedId, open, onClose, onSelect, onNew, onDelete, onDeleteAll, onOpenSettings, spend }: Props) {
  const now = useNow();

  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Close chat list"
          className="fixed inset-0 z-10 bg-black/40 md:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-20 flex w-72 max-w-[85vw] flex-col border-r border-neutral-200 bg-neutral-50 transition-transform md:static md:translate-x-0 dark:border-neutral-800 dark:bg-neutral-900 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-3">
          <button
            type="button"
            className="w-full rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            onClick={onNew}
          >
            New chat
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2" aria-label="Chats">
          {chats.length === 0 && <p className="px-2 py-4 text-sm text-neutral-500">No chats.</p>}
          <ul className="space-y-0.5">
            {chats.map((chat) => {
              const left = timeLeft(chat.expiresAt, now);
              const active = chat.id === selectedId;
              return (
                <li key={chat.id} className="group relative">
                  <button
                    type="button"
                    aria-current={active ? "page" : undefined}
                    className={`w-full rounded-md py-2 pr-9 pl-3 text-left ${
                      active ? "bg-neutral-200 dark:bg-neutral-800" : "hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
                    }`}
                    onClick={() => onSelect(chat.id)}
                  >
                    <span className="block truncate text-sm">{chat.title}</span>
                    <span className="block text-xs text-neutral-500">{left ? `Deletes in ${left}` : "Kept until deleted"}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete chat: ${chat.title}`}
                    title="Delete now"
                    className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-1.5 text-neutral-400 hover:bg-neutral-300 hover:text-red-600 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100 dark:hover:bg-neutral-700"
                    onClick={() => {
                      if (confirm(`Delete "${chat.title}" now? This cannot be undone.`)) onDelete(chat.id);
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                      <path d="M3 4h10M6.5 4V2.5h3V4M4.5 4l.5 9.5h6L11.5 4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="space-y-2 border-t border-neutral-200 p-3 text-xs text-neutral-500 dark:border-neutral-800">
          <button type="button" className="block hover:underline" onClick={onOpenSettings}>
            Settings
          </button>
          {chats.length > 0 && (
            <button
              type="button"
              className="block text-red-600 hover:underline"
              onClick={() => {
                if (confirm(`Delete all ${chats.length} chats now? This cannot be undone.`)) onDeleteAll();
              }}
            >
              Delete all chats
            </button>
          )}
          {spend && (
            <p title="Estimated model cost this calendar month at list prices. Your provider's bill is the real figure.">
              This month ≈ {formatUsd(spend.usd)}
            </p>
          )}
          <p className="truncate" title={me.email}>
            {me.email}
          </p>
        </div>
      </aside>
    </>
  );
}
