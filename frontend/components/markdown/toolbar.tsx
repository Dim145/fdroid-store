"use client";

import * as React from "react";
import type { Editor } from "@tiptap/react";
import {
  Bold,
  Code,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Undo2,
} from "lucide-react";

import { cn } from "@/lib/utils";

/* Toolbar — small, deliberate set of buttons that maps 1:1 to the F-Droid
   Markdown subset we accept. We don't expose heading / image / table buttons
   because the renderer would strip them anyway. */

export type ToolbarActionKey =
  | "bold"
  | "italic"
  | "code"
  | "bulletList"
  | "orderedList"
  | "blockquote"
  | "link"
  | "undo"
  | "redo";

type Action = {
  key: ToolbarActionKey;
  label: string;
  shortcut: string;
  icon: React.ReactNode;
  isActive?: (e: Editor) => boolean;
  isDisabled?: (e: Editor) => boolean;
  run: (e: Editor) => void;
  /** Buttons sharing a group sit flush; a thin vertical divider separates groups. */
  group: "text" | "block" | "insert" | "history";
};

const ACTIONS: readonly Action[] = [
  {
    key: "bold",
    label: "Bold",
    shortcut: "⌘B",
    icon: <Bold className="h-4 w-4" />,
    isActive: (e) => e.isActive("bold"),
    run: (e) => e.chain().focus().toggleBold().run(),
    group: "text",
  },
  {
    key: "italic",
    label: "Italic",
    shortcut: "⌘I",
    icon: <Italic className="h-4 w-4" />,
    isActive: (e) => e.isActive("italic"),
    run: (e) => e.chain().focus().toggleItalic().run(),
    group: "text",
  },
  {
    key: "code",
    label: "Inline code",
    shortcut: "⌘E",
    icon: <Code className="h-4 w-4" />,
    isActive: (e) => e.isActive("code"),
    run: (e) => e.chain().focus().toggleCode().run(),
    group: "text",
  },

  {
    key: "bulletList",
    label: "Bullet list",
    shortcut: "⌘⇧8",
    icon: <List className="h-4 w-4" />,
    isActive: (e) => e.isActive("bulletList"),
    run: (e) => e.chain().focus().toggleBulletList().run(),
    group: "block",
  },
  {
    key: "orderedList",
    label: "Numbered list",
    shortcut: "⌘⇧7",
    icon: <ListOrdered className="h-4 w-4" />,
    isActive: (e) => e.isActive("orderedList"),
    run: (e) => e.chain().focus().toggleOrderedList().run(),
    group: "block",
  },
  {
    key: "blockquote",
    label: "Quote",
    shortcut: "⌘⇧B",
    icon: <Quote className="h-4 w-4" />,
    isActive: (e) => e.isActive("blockquote"),
    run: (e) => e.chain().focus().toggleBlockquote().run(),
    group: "block",
  },

  {
    key: "link",
    label: "Link",
    shortcut: "⌘K",
    icon: <LinkIcon className="h-4 w-4" />,
    isActive: (e) => e.isActive("link"),
    // Implemented inline below — needs a URL prompt before calling Tiptap.
    run: () => {},
    group: "insert",
  },

  {
    key: "undo",
    label: "Undo",
    shortcut: "⌘Z",
    icon: <Undo2 className="h-4 w-4" />,
    // ``isDisabled`` for history is cached in component state (see below) —
    // the dry-run ``editor.can().chain().focus().undo().run()`` builds a
    // full ProseMirror transaction per call, too costly to do per render.
    run: (e) => e.chain().focus().undo().run(),
    group: "history",
  },
  {
    key: "redo",
    label: "Redo",
    shortcut: "⌘⇧Z",
    icon: <Redo2 className="h-4 w-4" />,
    run: (e) => e.chain().focus().redo().run(),
    group: "history",
  },
];

export interface ToolbarProps {
  editor: Editor;
  /** Rendered right-aligned in the toolbar — typically the Edit/Preview tab
   *  switch lives here. */
  rightSlot?: React.ReactNode;
  className?: string;
  /** Translated accessible names per action. Missing keys fall back to the
   *  English label baked into the action table. */
  labels?: Partial<Record<ToolbarActionKey, string>>;
  /** Translated ``aria-label`` for the toolbar landmark itself. */
  ariaLabel?: string;
  /** Translated text shown in the link-URL prompt. */
  linkPrompt?: string;
}

export function Toolbar({
  editor,
  rightSlot,
  className,
  labels,
  ariaLabel = "Formatting",
  linkPrompt = "URL (https://… or mailto:…)",
}: ToolbarProps) {
  // Re-render on every transaction so ``isActive`` reflects the live
  // cursor / mark state. ``selectionUpdate`` is redundant — every cursor
  // move emits a transaction too, so subscribing to both would force two
  // re-renders per arrow-key press.
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  // History state cached separately — the ``editor.can().chain().focus()
  // .undo().run()`` dry-run that backs ``isDisabled`` builds a full
  // ProseMirror transaction per call, far too expensive to do once per
  // button per render.
  const [history, setHistory] = React.useState({ canUndo: false, canRedo: false });
  React.useEffect(() => {
    const onTx = () => {
      force();
      setHistory({
        canUndo: editor.can().chain().focus().undo().run(),
        canRedo: editor.can().chain().focus().redo().run(),
      });
    };
    editor.on("transaction", onTx);
    return () => { editor.off("transaction", onTx); };
  }, [editor]);

  const promptForLinkAndApply = React.useCallback(() => {
    const previous = (editor.getAttributes("link") as { href?: string }).href ?? "";
    // Native prompt — minimal, accessible, no extra deps. Cancel = no-op;
    // an empty value unlinks so users can remove a link from the same button.
    const next = window.prompt(linkPrompt, previous);
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: trimmed })
      .run();
  }, [editor, linkPrompt]);

  let lastGroup: Action["group"] | null = null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1 border-b border-outline-soft",
        "bg-gradient-to-b from-surface-2/60 to-surface px-2 py-1.5",
        className,
      )}
      role="toolbar"
      aria-label={ariaLabel}
    >
      {ACTIONS.map((action) => {
        const showDivider = lastGroup !== null && lastGroup !== action.group;
        lastGroup = action.group;
        const isActive = action.isActive?.(editor) ?? false;
        const isDisabled =
          action.key === "undo" ? !history.canUndo
            : action.key === "redo" ? !history.canRedo
            : action.isDisabled?.(editor) ?? false;
        const accessibleLabel = labels?.[action.key] ?? action.label;

        return (
          <React.Fragment key={action.key}>
            {showDivider && (
              <span
                aria-hidden
                className="mx-1 h-5 w-px bg-outline-soft"
              />
            )}
            <button
              type="button"
              onMouseDown={(e) => {
                // Keep focus inside the editor so the formatting command
                // applies to the live selection; clicking the button would
                // otherwise collapse the selection on some browsers.
                e.preventDefault();
              }}
              onClick={() => {
                if (isDisabled) return;
                if (action.key === "link") {
                  promptForLinkAndApply();
                } else {
                  action.run(editor);
                }
              }}
              disabled={isDisabled}
              aria-pressed={isActive}
              aria-label={accessibleLabel}
              title={`${accessibleLabel}  ·  ${action.shortcut}`}
              className={cn(
                "inline-flex h-8 w-8 items-center justify-center rounded-lg",
                "text-ink-soft transition-all duration-150 ease-out",
                "hover:bg-surface-3 hover:text-ink",
                "active:scale-[0.92]",
                "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                isActive &&
                  "bg-primary-container text-primary-on-container hover:bg-primary-container",
              )}
            >
              {action.icon}
            </button>
          </React.Fragment>
        );
      })}
      {rightSlot && (
        <div className="ml-auto flex items-center gap-1">{rightSlot}</div>
      )}
    </div>
  );
}
