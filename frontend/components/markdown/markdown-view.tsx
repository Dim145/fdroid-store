"use client";

import { useMemo } from "react";
import DOMPurify from "isomorphic-dompurify";
import { marked } from "marked";

import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   F-Droid-compatible Markdown renderer
   ----------------------------------------------------------------------------
   The F-Droid Android client renders a *subset* of Markdown for description
   fields. We deliberately mirror that subset so what authors see on the
   website matches what users will see in the official client:

     ✓ paragraphs, bold, italic, inline code
     ✓ bullet + ordered lists
     ✓ block quotes
     ✓ links  (http / https / mailto / fdroidrepos)
     ✗ headings  → demoted to plain paragraphs
     ✗ images    → stripped (no inline images in F-Droid descriptions)
     ✗ tables    → stripped (GFM disabled in `marked` below)
     ✗ raw HTML  → stripped by DOMPurify's tag/attribute allowlist
     ✗ code blocks → demoted to inline code

   The two-stage pipeline (marked → DOMPurify) is belt-and-braces: marked
   produces a known HTML shape, then DOMPurify enforces our allowlist so a
   parser regression can never become an XSS vector.
   ---------------------------------------------------------------------------- */

const ALLOWED_TAGS = [
  "p", "br",
  "strong", "em", "b", "i",
  "a",
  "ul", "ol", "li",
  "blockquote",
  "code",
];
const ALLOWED_ATTR = ["href"];

// Match marked's option shape; called once at module load.
marked.setOptions({
  gfm: false,    // disables tables, strikethrough, autolinks. We re-enable
                 // manual links via the `[label](url)` form which is CommonMark.
  breaks: true,  // single newlines become <br> — matches the Android client's
                 // wrap-on-newline behaviour for descriptions.
});

/** Convert F-Droid-compatible Markdown to a sanitised HTML fragment. */
export function renderFdroidMarkdown(markdown: string): string {
  if (!markdown || !markdown.trim()) return "";
  // `marked.parse` is sync when `async: false` (default in v14 for non-async
  // extensions). The cast keeps TS happy without dragging the async overload in.
  const raw = marked.parse(markdown, { async: false }) as string;

  // Strip headings + images + tables BEFORE DOMPurify so their inner text is
  // preserved as paragraph content. DOMPurify's default mode would strip the
  // tag but keep the children — which for an <img> means nothing, but for an
  // <h1> means the text survives, which is exactly what we want. So we let
  // DOMPurify handle the de-tagging via the allowlist below.

  const safe = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Only allow safe URL schemes. The default DOMPurify regex covers http(s)
    // and mailto; we extend it with the F-Droid-specific `fdroidrepos:` so a
    // description can link to another repo install flow.
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|fdroidrepos):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });

  // Force every anchor to open in a new tab with hardened rel attributes.
  // Done on the sanitised string so we know there are no injected attributes
  // already on the tag. (`ugc` flags this as user-generated content for SEO.)
  return safe.replace(
    /<a\b([^>]*?)>/g,
    (_m, attrs) => `<a${attrs} target="_blank" rel="noopener nofollow ugc">`,
  );
}

type Props = {
  markdown: string | null | undefined;
  className?: string;
  /** When set, the rendered output is collapsed to roughly this many lines
   *  using a CSS line-clamp. The parent should pair this with an "Expand"
   *  toggle for the user to reveal the rest. */
  maxLines?: number;
};

/** Renders user-supplied Markdown as a styled, sanitised HTML fragment.
 *
 *  Styling lives in the `.prose-md` class (see ``globals.css``) so the same
 *  rendering looks at home on the public app page and inside the editor's
 *  "Preview" tab. */
export function MarkdownView({ markdown, className, maxLines }: Props) {
  const html = useMemo(() => renderFdroidMarkdown(markdown ?? ""), [markdown]);

  if (!html) return null;

  return (
    <div
      className={cn(
        "prose-md",
        maxLines ? "prose-md--clamped" : null,
        className,
      )}
      style={maxLines ? { ["--prose-md-max-lines" as string]: maxLines } : undefined}
      // eslint-disable-next-line react/no-danger -- output already sanitised by DOMPurify above.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
