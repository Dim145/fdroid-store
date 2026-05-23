"use client";

import * as React from "react";
import type { Editor } from "@tiptap/react";
import { EditorContent, useEditor } from "@tiptap/react";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { Eye, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import { MarkdownView } from "./markdown-view";
import { Toolbar, type ToolbarActionKey } from "./toolbar";

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

   Paste behaviour:
     • Markdown text  → kept as-is (tiptap-markdown parses it on input).
     • HTML (e.g. from a Notion / Google Doc paste) → parsed by ProseMirror
       and re-serialised through tiptap-markdown, so only the subset we
       support survives. Anything else is dropped silently.
   ---------------------------------------------------------------------------- */

const HARD_MAX = 20_000;

/** ``tiptap-markdown`` registers a serialiser at ``editor.storage.markdown``.
 *  Centralising the cast here keeps the typing dance out of the call sites. */
function getMarkdown(editor: Editor): string {
  type WithMarkdown = { markdown?: { getMarkdown: () => string } };
  return (editor.storage as WithMarkdown).markdown?.getMarkdown() ?? "";
}

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

  // ``onUpdate`` captures its environment at editor-construction time. We
  // route ``onChange`` and ``maxLength`` through refs so a parent that
  // passes a new inline lambda on every render (the typical pattern with
  // <LocalizationsEditor> swapping rows) still gets every keystroke —
  // otherwise the closure freezes at mount and edits silently vanish.
  const onChangeRef = React.useRef(onChange);
  const maxLengthRef = React.useRef(maxLength);
  React.useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  React.useEffect(() => { maxLengthRef.current = maxLength; }, [maxLength]);

  // Extensions + editorProps are memoised so Tiptap doesn't tear down the
  // editor on every render. Without this, every keystroke re-runs
  // ``editor.setOptions`` and re-applies ``view.setProps`` — heavy when
  // multiple editors are mounted (one per locale in <LocalizationsEditor>).
  const extensions = React.useMemo(
    () => [
      StarterKit.configure({
        // Disable everything that isn't part of the F-Droid subset. Anything
        // we leave enabled here ALSO has to be allowed in <MarkdownView> or
        // it'll round-trip differently between editor and public page.
        heading: false,
        horizontalRule: false,
        codeBlock: false,
        strike: false,
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
        emptyEditorClass: "is-editor-empty",
      }),
      Markdown.configure({
        html: false,
        tightLists: true,
        bulletListMarker: "-",
        linkify: false,
        breaks: true,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    [placeholder],
  );

  const editorAttrs = React.useMemo(
    () => ({
      id: id ?? "",
      role: "textbox",
      "aria-multiline": "true",
      // ``prose-md`` is shared with MarkdownView so the editor surface looks
      // pixel-identical to the public page.
      class: cn(
        "prose-md tiptap-content min-h-[var(--tiptap-min-h)] focus:outline-none",
      ),
    }),
    [id],
  );

  const editorProps = React.useMemo(
    () => ({ attributes: editorAttrs }),
    [editorAttrs],
  );

  // ``content`` is the INITIAL doc only. Tiptap stores it on options but
  // doesn't reset the live doc when it changes — and we don't want it to
  // (the effect below handles external value changes with an
  // ``isFocused`` guard). Capture once via ref so this never appears
  // in the options diff and triggers a redundant ``view.updateState``.
  const initialContentRef = React.useRef(value);

  const editor = useEditor({
    immediatelyRender: false,
    // Drop legacy "re-render the host component on every transaction" — we
    // don't read editor state during render. The Toolbar subscribes
    // directly to the events it cares about.
    shouldRerenderOnTransaction: false,
    editable: !disabled,
    extensions,
    content: initialContentRef.current,
    editorProps,
    onUpdate({ editor }) {
      onChangeRef.current(getMarkdown(editor).slice(0, maxLengthRef.current));
    },
  });

  // Sync external ``value`` changes back into the editor (e.g. a form reset
  // after save). The ``isFocused`` guard avoids resetting content while the
  // user is typing — that would jump the cursor to the end on any parent
  // re-render that happens to carry a slightly-normalised value.
  React.useEffect(() => {
    if (!editor || editor.isFocused) return;
    if (getMarkdown(editor) !== value) {
      editor.commands.setContent(value, false);
    }
  }, [value, editor]);

  React.useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  // Stable label map keyed by ToolbarActionKey — re-derived only on language
  // change, not per render.
  const toolbarLabels = React.useMemo<Partial<Record<ToolbarActionKey, string>>>(
    () => ({
      bold: t("markdown.toolbar.bold"),
      italic: t("markdown.toolbar.italic"),
      code: t("markdown.toolbar.code"),
      bulletList: t("markdown.toolbar.bulletList"),
      orderedList: t("markdown.toolbar.orderedList"),
      blockquote: t("markdown.toolbar.quote"),
      link: t("markdown.toolbar.link"),
      undo: t("markdown.toolbar.undo"),
      redo: t("markdown.toolbar.redo"),
    }),
    [t],
  );

  const charCount = value.length;
  const overLimitSoon = charCount > maxLength * 0.9;

  // SSR / pre-mount: ``useEditor({ immediatelyRender: false })`` returns
  // ``null`` until the client picks it up. Render an inert shape so the
  // surrounding form layout doesn't jump when the editor hydrates.
  if (!editor) {
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
        labels={toolbarLabels}
        ariaLabel={t("markdown.toolbar.ariaLabel")}
        linkPrompt={t("markdown.toolbar.linkPrompt")}
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
