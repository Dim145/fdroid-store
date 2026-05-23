"use client";

import * as React from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { Eye, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import { MarkdownView } from "./markdown-view";
import { Toolbar } from "./toolbar";

/* ----------------------------------------------------------------------------
   <MarkdownEditor>
   ----------------------------------------------------------------------------
   A controlled WYSIWYG bound to a Markdown string. The editor renders rich
   text (via Tiptap / ProseMirror) but the value you pass in / get back out is
   always a Markdown string — that's what we persist in `apps.description`
   and what the F-Droid v1 / v2 index generators serialise verbatim.

   The Markdown subset matches what <MarkdownView> renders: bold, italic, code,
   bullet + ordered lists, block quotes, links. Headings, images, tables and
   inline HTML are stripped on paste so what the user sees in the editor is
   exactly what every F-Droid client will display.

   The toolbar is grouped (text → block → insert → history) with a tab switch
   on the right that flips the surface from Edit mode to a read-only Preview
   that uses the *same* renderer as the public app page. That guarantees
   the author can never be surprised at publish time.

   Paste behaviour:
     • Markdown text  → kept as-is (tiptap-markdown parses it on input).
     • HTML (e.g. from a Notion / Google Doc paste) → parsed by ProseMirror
       and re-serialised through tiptap-markdown, so only the subset we
       support survives. Anything else is dropped silently.
   ---------------------------------------------------------------------------- */

const HARD_MAX = 20_000; // matches the textarea cap previously enforced.

export type MarkdownEditorProps = {
  /** Current Markdown value. Treated as a controlled prop. */
  value: string;
  /** Called on every keystroke with the up-to-date Markdown string. */
  onChange: (markdown: string) => void;
  id?: string;
  placeholder?: string;
  /** Hard character limit on the Markdown source. Defaults to 20 000. */
  maxLength?: number;
  /** Roughly how tall the editing surface should grow before it scrolls. */
  minRows?: number;
  className?: string;
  disabled?: boolean;
};

export function MarkdownEditor({
  value,
  onChange,
  id,
  placeholder,
  maxLength = HARD_MAX,
  minRows = 6,
  className,
  disabled = false,
}: MarkdownEditorProps) {
  const { t } = useTranslation();
  const [mode, setMode] = React.useState<"edit" | "preview">("edit");
  const [mounted, setMounted] = React.useState(false);

  // Tiptap mutates the DOM on first render; on Next.js' streaming server-side
  // pass that would mismatch the client hydration. Mount-detection lets us
  // render an inert textarea-shaped placeholder for the first paint so the
  // layout doesn't jump when the editor takes over.
  React.useEffect(() => setMounted(true), []);

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        // Disable everything that isn't part of the F-Droid subset. Anything
        // we leave enabled here ALSO has to be allowed in <MarkdownView> or
        // it'll round-trip differently between editor and public page.
        heading: false,
        horizontalRule: false,
        codeBlock: false,
        strike: false,
        // Keep: paragraph, bold, italic, code (inline), bulletList,
        // orderedList, listItem, blockquote, hardBreak, history.
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        protocols: ["http", "https", "mailto", "fdroidrepos"],
        HTMLAttributes: {
          rel: "noopener nofollow ugc",
          target: "_blank",
        },
      }),
      Placeholder.configure({
        placeholder: placeholder ?? "",
        emptyEditorClass:
          "before:content-[attr(data-placeholder)] before:text-ink-mute before:float-left before:h-0 before:pointer-events-none",
      }),
      Markdown.configure({
        html: false,           // never accept raw HTML through the markdown bridge
        tightLists: true,
        bulletListMarker: "-",
        linkify: false,        // we already enabled `autolink` on the Link ext
        breaks: true,          // single newlines preserved as <br> on output
        transformPastedText: true, // paste of "**foo**" becomes bold immediately
        transformCopiedText: true, // copy gives Markdown back to the OS clipboard
      }),
    ],
    content: value,
    editorProps: {
      attributes: {
        id: id ?? "",
        role: "textbox",
        "aria-multiline": "true",
        // The `prose-md` class shares styling with MarkdownView so the editor
        // surface looks pixel-identical to the public page.
        class: cn(
          "prose-md tiptap-content min-h-[var(--tiptap-min-h)] focus:outline-none",
        ),
      },
    },
    onUpdate({ editor }) {
      // `tiptap-markdown` registers `editor.storage.markdown` on init.
      // The cast trims the explicit typing dance for what is a tiny lookup.
      const md =
        (editor.storage as { markdown?: { getMarkdown: () => string } }).markdown?.getMarkdown() ?? "";
      onChange(md.slice(0, maxLength));
    },
  });

  // Keep the editor in sync when `value` is updated externally (e.g. the form
  // resets after a successful save). We only push downstream when the prop
  // diverges from what the editor currently holds, otherwise every keystroke
  // would round-trip and the cursor would jump to the end. `tiptap-markdown`
  // auto-detects markdown vs HTML strings inside ``setContent``, so we just
  // hand it the raw value.
  React.useEffect(() => {
    if (!editor) return;
    const current =
      (editor.storage as { markdown?: { getMarkdown: () => string } }).markdown?.getMarkdown() ?? "";
    if (current !== value) {
      // Tiptap v2 signature: setContent(content, emitUpdate?, parseOptions?).
      // We pass `emitUpdate: false` so our own React effect doesn't loop.
      editor.commands.setContent(value, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only react to value changes
  }, [value, editor]);

  // Re-run editability when the prop flips (e.g. while a save is pending).
  React.useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const charCount = value.length;
  const overLimitSoon = charCount > maxLength * 0.9;

  // Before mount, render a static placeholder with the same outer shape so the
  // form layout doesn't shift when the editor hydrates.
  if (!mounted || !editor) {
    return (
      <div
        className={cn(
          "rounded-xl border border-outline bg-surface",
          "min-h-[calc(var(--tiptap-min-h)+5rem)]",
          className,
        )}
        style={{ ["--tiptap-min-h" as string]: `${minRows * 1.65}rem` }}
        aria-busy="true"
      >
        <div className="h-10 border-b border-outline-soft bg-surface-2/40" />
        <div className="px-4 py-3 text-sm text-ink-mute">…</div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group relative rounded-xl border border-outline bg-surface",
        "transition-[border-color,box-shadow] duration-150 ease-out",
        "focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/20",
        disabled && "opacity-60",
        className,
      )}
      style={{ ["--tiptap-min-h" as string]: `${minRows * 1.65}rem` }}
    >
      <Toolbar
        editor={editor}
        labels={{
          bold: t("markdown.toolbar.bold"),
          italic: t("markdown.toolbar.italic"),
          code: t("markdown.toolbar.code"),
          bulletList: t("markdown.toolbar.bulletList"),
          orderedList: t("markdown.toolbar.orderedList"),
          blockquote: t("markdown.toolbar.quote"),
          link: t("markdown.toolbar.link"),
          undo: t("markdown.toolbar.undo"),
          redo: t("markdown.toolbar.redo"),
        }}
        rightSlot={
          <div
            role="tablist"
            aria-label={t("markdown.viewMode")}
            className="ml-1 inline-flex items-center rounded-pill border border-outline-soft bg-surface p-0.5 text-xs"
          >
            <ModeTab
              active={mode === "edit"}
              onClick={() => setMode("edit")}
              icon={<Pencil className="h-3 w-3" />}
              label={t("markdown.edit")}
            />
            <ModeTab
              active={mode === "preview"}
              onClick={() => setMode("preview")}
              icon={<Eye className="h-3 w-3" />}
              label={t("markdown.preview")}
            />
          </div>
        }
      />

      <div className="relative">
        {mode === "edit" ? (
          <EditorContent
            editor={editor}
            className="px-4 py-3 [&_.tiptap-content]:max-h-[28rem] [&_.tiptap-content]:overflow-y-auto"
          />
        ) : (
          <div className="px-4 py-3">
            {value.trim() ? (
              <MarkdownView markdown={value} />
            ) : (
              <p className="italic text-ink-mute">
                {placeholder || t("markdown.previewEmpty")}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-outline-soft px-3 py-1.5 text-[11px]">
        <span
          className="inline-flex items-center gap-1.5 text-ink-mute"
          title={t("markdown.helpHint")}
        >
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full bg-primary/70"
          />
          {t("markdown.acceptsMarkdown")}
        </span>
        <span
          className={cn(
            "tabular-nums text-ink-mute",
            overLimitSoon && "text-accent",
          )}
        >
          {charCount.toLocaleString()} / {maxLength.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 font-medium",
        "transition-colors duration-150 ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        active
          ? "bg-primary-container text-primary-on-container"
          : "text-ink-mute hover:text-ink",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
