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

// Module-scope config — frozen so the same object identity is handed to
// DOMPurify on every call, and ``marked`` is configured exactly once.
const SANITIZE_CONFIG = Object.freeze({
  ALLOWED_TAGS: [
    "p", "br",
    "strong", "em", "b", "i",
    "a",
    "ul", "ol", "li",
    "blockquote",
    "code",
  ],
  ALLOWED_ATTR: ["href"],
  // Allow only safe URL schemes. The default DOMPurify regex covers http(s) +
  // mailto; we extend it with ``fdroidrepos:`` so a description can deep-link
  // into another repo install flow.
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|mailto|fdroidrepos):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
});

marked.setOptions({
  gfm: false,
  breaks: true,
});

// Force every anchor to open in a new tab with hardened rel attributes.
// This MUST run as a DOMPurify hook (mutating the parsed DOM node mid-sanitize)
// and NEVER as a post-sanitize string/regex rewrite. DOMPurify legitimately
// emits a literal ``>`` inside a quoted ``href`` value, so an ``<a …>`` regex
// over its *output* stops at that inner ``>``, splits the tag, and ejects
// whatever followed (e.g. ``<img onerror=…>``) back into live markup — a
// textbook sanitiser-bypass XSS. Setting the attributes here keeps DOMPurify
// the final authority over the serialized HTML. ``ugc`` flags the link as
// user-generated content for SEO crawlers. The hook is registered once at
// module load (ES module singleton) and only ever touches anchors, so it is
// safe to share with any other sanitise call in the app.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName === "A" && "setAttribute" in node) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener nofollow ugc");
  }
});

/** Convert F-Droid-compatible Markdown to a sanitised HTML fragment.
 *
 *  Tags outside ``SANITIZE_CONFIG.ALLOWED_TAGS`` are stripped by DOMPurify
 *  while keeping their text content — so an ``<h1>`` becomes a bare run of
 *  text, an ``<img>`` disappears entirely (no children), and tables are
 *  killed at the parser level via ``gfm: false`` above.
 */
export function renderFdroidMarkdown(markdown: string): string {
  if (!markdown || !markdown.trim()) return "";
  // ``marked.parse`` is sync when ``async: false`` (default in v14 for
  // non-async extensions). The cast trims the async overload out of TS's
  // return-type union.
  const raw = marked.parse(markdown, { async: false }) as string;
  // DOMPurify is the LAST thing to touch the HTML — the anchor target/rel
  // hardening happens inside it via the ``afterSanitizeAttributes`` hook
  // above, never as a post-hoc string rewrite (see the hook comment).
  return DOMPurify.sanitize(raw, SANITIZE_CONFIG);
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
