import { type ReactNode, type SyntheticEvent, useEffect, useRef } from "react";

type Props = {
  /** Called when the dialog asks to close (Esc, or a close button inside calling it). */
  onClose: () => void;
  /** Return false to keep the dialog open, for example to confirm discarding changes. */
  canClose?: () => boolean;
  /** Close when the dimmed area outside the dialog is clicked. */
  closeOnBackdrop?: boolean;
  className?: string;
  children: ReactNode;
  "aria-labelledby"?: string;
  "aria-label"?: string;
};

/**
 * A native modal <dialog>: the browser keeps focus inside it, makes the page behind inert,
 * closes it on Esc and puts focus back where it was when it closes.
 */
export function Modal({ onClose, canClose, closeOnBackdrop = false, className = "", children, ...aria }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  const requestClose = () => {
    if (!canClose || canClose()) onClose();
  };

  // Esc: let the parent decide, so it can unmount the dialog (or keep it open).
  const onCancel = (event: SyntheticEvent) => {
    event.preventDefault();
    requestClose();
  };

  return (
    <dialog
      ref={ref}
      {...aria}
      onCancel={onCancel}
      onClick={(event) => {
        // A click on the dialog element itself (not its contents) is a click on the backdrop.
        if (closeOnBackdrop && event.target === ref.current) requestClose();
      }}
      className={`m-auto max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] text-neutral-900 backdrop:bg-black/40 dark:text-neutral-100 ${className}`}
    >
      {children}
    </dialog>
  );
}
