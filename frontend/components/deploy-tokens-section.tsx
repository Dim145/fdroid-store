"use client";

import {
  BookOpen,
  Check,
  Copy,
  Info,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type DeployToken, type DeployTokenCreated } from "@/lib/api";
import { toast } from "@/lib/toast-store";
import { cn, formatDate } from "@/lib/utils";


/* The endpoint the CI runner POSTs to. Surfaced verbatim in the
 * one-time reveal so the user can paste it directly into their
 * pipeline config. */
function uploadUrlFor(appId: string): string {
  if (typeof window === "undefined") return `/api/v1/apks/upload/${appId}`;
  return `${window.location.origin}/api/v1/apks/upload/${appId}`;
}


export function DeployTokensSection({
  appId,
}: {
  appId: string;
}) {
  const { t } = useTranslation();
  const [tokens, setTokens] = useState<DeployToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<DeployTokenCreated | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [instructionsOpen, setInstructionsOpen] = useState(false);

  async function reload() {
    try {
      setTokens(await api.deployTokens.list(appId));
    } catch (e) {
      toast.error(
        t("myApps.edit.deployTokens.loadFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const fresh = await api.deployTokens.create(appId, { name: name.trim() });
      setCreated(fresh);
      setName("");
      await reload();
    } catch (e) {
      toast.error(
        t("myApps.edit.deployTokens.createFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(token: DeployToken) {
    if (!confirm(t("myApps.edit.deployTokens.revokeConfirm", { name: token.name }))) return;
    setRevoking(token.id);
    try {
      await api.deployTokens.revoke(appId, token.id);
      toast.success(t("myApps.edit.deployTokens.revoked"));
      await reload();
    } catch (e) {
      toast.error(
        t("myApps.edit.deployTokens.revokeFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setRevoking(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-mute">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  const active = tokens.filter((t) => t.revoked_at === null);
  const revoked = tokens.filter((t) => t.revoked_at !== null);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-xs leading-relaxed text-ink-soft">
          {t("myApps.edit.deployTokens.body")}
        </p>
        {/* Documentation pop-up — consultable any time, doesn't require
            minting a new token. Shows the upload URL + auth header +
            method + sample CI snippets with ``<YOUR_TOKEN>`` placeholder. */}
        <button
          type="button"
          onClick={() => setInstructionsOpen(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-outline-soft bg-surface px-3 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-primary hover:text-primary"
          aria-label={t("myApps.edit.deployTokens.instructions.openLabel")}
        >
          <Info className="h-3.5 w-3.5" />
          {t("myApps.edit.deployTokens.instructions.button")}
        </button>
      </div>

      <form onSubmit={onCreate} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[14rem] flex-1 space-y-1.5">
            <Label htmlFor="deploy-token-name" className="text-xs font-medium uppercase tracking-wider text-ink-mute">
              {t("myApps.edit.deployTokens.nameLabel")}
            </Label>
            <Input
              id="deploy-token-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("myApps.edit.deployTokens.namePlaceholder")}
              maxLength={128}
            />
          </div>
          <Button type="submit" variant="filled" disabled={creating || !name.trim()}>
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            {t("myApps.edit.deployTokens.create")}
          </Button>
        </form>

      {/* Token list */}
      <ul className="space-y-1.5">
        {active.length === 0 && revoked.length === 0 && (
          <li className="rounded-2xl border border-dashed border-outline px-4 py-8 text-center italic text-ink-mute">
            {t("myApps.edit.deployTokens.empty")}
          </li>
        )}
        {active.map((tok) => (
          <TokenRow
            key={tok.id}
            token={tok}
            canRevoke={true}
            busy={revoking === tok.id}
            onRevoke={() => onRevoke(tok)}
          />
        ))}
        {revoked.length > 0 && (
          <>
            <li className="mt-4 font-mono text-[10px] uppercase tracking-wider text-ink-mute">
              {t("myApps.edit.deployTokens.revokedHeader")}
            </li>
            {revoked.map((tok) => (
              <TokenRow
                key={tok.id}
                token={tok}
                canRevoke={false}
                busy={false}
                onRevoke={() => {}}
              />
            ))}
          </>
        )}
      </ul>

      {/* One-time reveal modal */}
      {created && (
        <RevealModal
          token={created}
          appId={appId}
          onClose={() => setCreated(null)}
        />
      )}

      {/* Always-available "how to publish" reference */}
      {instructionsOpen && (
        <InstructionsModal
          appId={appId}
          onClose={() => setInstructionsOpen(false)}
        />
      )}
    </div>
  );
}


function TokenRow({
  token,
  canRevoke,
  busy,
  onRevoke,
}: {
  token: DeployToken;
  canRevoke: boolean;
  busy: boolean;
  onRevoke: () => void;
}) {
  const { t } = useTranslation();
  const revoked = token.revoked_at !== null;
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-2xl border bg-surface px-4 py-3",
        revoked ? "border-outline-soft opacity-65" : "border-outline-soft",
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink-soft">
        <KeyRound className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-ink">{token.name}</div>
        <div className="font-mono text-[11px] text-ink-mute">
          fdci_{token.prefix}_…
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {revoked ? (
          <Badge variant="destructive">{t("myApps.edit.deployTokens.revokedBadge")}</Badge>
        ) : (
          <Badge variant="primary">{t("myApps.edit.deployTokens.active")}</Badge>
        )}
      </div>
      <div className="hidden w-32 shrink-0 text-right text-[11px] text-ink-mute md:block">
        <div>
          {t("myApps.edit.deployTokens.lastUsed")}{" "}
          <span className="font-mono">{formatDate(token.last_used_at)}</span>
        </div>
      </div>
      {canRevoke && !revoked && (
        <Button size="sm" variant="outlined" onClick={onRevoke} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          {t("myApps.edit.deployTokens.revoke")}
        </Button>
      )}
    </li>
  );
}


/** One-shot modal that shows the full secret + ready-to-copy CI snippets.
 *  Identical aesthetic chrome to the GithubSource proposed-fields modal
 *  so the pair feels intentional. */
function RevealModal({
  token,
  appId,
  onClose,
}: {
  token: DeployTokenCreated;
  appId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"curl" | "ghactions" | "gitlabci">("curl");
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const focusId = window.setTimeout(() => closeBtnRef.current?.focus(), 40);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(focusId);
    };
  }, [onClose]);

  const url = uploadUrlFor(appId);
  const snippets: Record<typeof tab, string> = {
    curl: `curl -X POST "${url}" \\\n  -H "Authorization: Bearer ${token.full_token}" \\\n  -F "file=@build/outputs/apk/release/app-release.apk"`,
    ghactions:
      `# .github/workflows/release.yml\n` +
      `- name: Publish APK to fdroid-store\n` +
      `  run: |\n` +
      `    curl -fSL -X POST "${url}" \\\n` +
      `      -H "Authorization: Bearer \${{ secrets.FDROID_DEPLOY_TOKEN }}" \\\n` +
      `      -F "file=@build/outputs/apk/release/app-release.apk"`,
    gitlabci:
      `# .gitlab-ci.yml\n` +
      `publish_apk:\n` +
      `  stage: deploy\n` +
      `  script:\n` +
      `    - |\n` +
      `      curl -fSL -X POST "${url}" \\\n` +
      `        -H "Authorization: Bearer $FDROID_DEPLOY_TOKEN" \\\n` +
      `        -F "file=@build/outputs/apk/release/app-release.apk"`,
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8">
      <button
        type="button"
        aria-label={t("common.close")}
        onClick={onClose}
        className="absolute inset-0 animate-fade-in bg-black/45 backdrop-blur-[3px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="deploy-token-reveal-title"
        className="relative w-full max-w-2xl animate-modal-pop overflow-hidden rounded-3xl border border-outline-soft bg-surface shadow-e4"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(70% 100% at 100% 0%, rgb(var(--primary) / 0.16), transparent 60%)",
          }}
        />
        <div aria-hidden className="pointer-events-none absolute left-5 top-5 h-8 w-8">
          <div className="absolute inset-x-0 top-0 h-px bg-outline" />
          <div className="absolute inset-y-0 left-0 w-px bg-outline" />
        </div>

        <div className="relative p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-primary text-primary-fg shadow-e1">
                <KeyRound className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-primary">
                  {t("myApps.edit.deployTokens.reveal.eyebrow")}
                </div>
                <h3
                  id="deploy-token-reveal-title"
                  className="mt-1 text-lg font-bold leading-tight tracking-tight text-ink"
                >
                  {t("myApps.edit.deployTokens.reveal.title", { name: token.name })}
                </h3>
              </div>
            </div>
            <button
              ref={closeBtnRef}
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill text-ink-mute transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-soft">
            {t("myApps.edit.deployTokens.reveal.body")}
          </p>

          <CredentialBlock
            label={t("myApps.edit.deployTokens.reveal.fullToken")}
            value={token.full_token}
          />

          <div className="mt-4">
            <div className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
              {t("myApps.edit.deployTokens.reveal.snippets")}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              <SnippetTab active={tab === "curl"} onClick={() => setTab("curl")}>curl</SnippetTab>
              <SnippetTab active={tab === "ghactions"} onClick={() => setTab("ghactions")}>GitHub Actions</SnippetTab>
              <SnippetTab active={tab === "gitlabci"} onClick={() => setTab("gitlabci")}>GitLab CI</SnippetTab>
            </div>
            <CredentialBlock value={snippets[tab]} multiline />
          </div>

          <div className="mt-5 flex items-center justify-end border-t border-outline-soft pt-4">
            <Button type="button" variant="filled" size="sm" onClick={onClose}>
              <Check className="h-3.5 w-3.5" /> {t("myApps.edit.deployTokens.reveal.acknowledge")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}


function SnippetTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-pill px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
        active
          ? "bg-primary text-primary-fg"
          : "bg-surface-2 text-ink-soft hover:bg-surface hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}


function CredentialBlock({
  label,
  value,
  multiline,
}: {
  label?: string;
  value: string;
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked */
    }
  }
  return (
    <div className="mt-2">
      {label && (
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-mute">
          {label}
        </div>
      )}
      <div className="relative">
        <pre
          className={cn(
            "select-all overflow-x-auto rounded-xl border border-outline-soft bg-surface-2 p-3 pr-12 font-mono text-[11px] text-ink-soft",
            multiline ? "whitespace-pre-wrap" : "whitespace-nowrap",
          )}
        >
          {value}
        </pre>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy"
          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-pill bg-surface text-ink-soft transition-colors hover:text-ink"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}


/** Always-available reference modal explaining the upload contract.
 *  Distinct from :func:`RevealModal` (post-mint, celebratory) — this
 *  is a cold spec sheet the operator can pull up whenever they're
 *  wiring a new CI runner. Uses a ``<YOUR_TOKEN>`` placeholder
 *  because we don't (and can't) remember the plaintext token. */
function InstructionsModal({
  appId,
  onClose,
}: {
  appId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"curl" | "ghactions" | "gitlabci">("curl");
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const focusId = window.setTimeout(() => closeBtnRef.current?.focus(), 40);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(focusId);
    };
  }, [onClose]);

  const url = uploadUrlFor(appId);
  const PLACEHOLDER = "<YOUR_TOKEN>";
  const snippets: Record<typeof tab, string> = {
    curl: `curl -X POST "${url}" \\\n  -H "Authorization: Bearer ${PLACEHOLDER}" \\\n  -F "file=@build/outputs/apk/release/app-release.apk"`,
    ghactions:
      `# .github/workflows/release.yml\n` +
      `- name: Publish APK to fdroid-store\n` +
      `  run: |\n` +
      `    curl -fSL -X POST "${url}" \\\n` +
      `      -H "Authorization: Bearer \${{ secrets.FDROID_DEPLOY_TOKEN }}" \\\n` +
      `      -F "file=@build/outputs/apk/release/app-release.apk"`,
    gitlabci:
      `# .gitlab-ci.yml\n` +
      `publish_apk:\n` +
      `  stage: deploy\n` +
      `  script:\n` +
      `    - |\n` +
      `      curl -fSL -X POST "${url}" \\\n` +
      `        -H "Authorization: Bearer $FDROID_DEPLOY_TOKEN" \\\n` +
      `        -F "file=@build/outputs/apk/release/app-release.apk"`,
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8">
      <button
        type="button"
        aria-label={t("common.close")}
        onClick={onClose}
        className="absolute inset-0 animate-fade-in bg-black/45 backdrop-blur-[3px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="deploy-token-instructions-title"
        className="relative w-full max-w-2xl animate-modal-pop overflow-hidden rounded-3xl border border-outline-soft bg-surface shadow-e4"
      >
        {/* Cooler corner wash than the reveal modal (less primary,
            more neutral) — this is documentation, not celebration. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(70% 100% at 100% 0%, rgb(var(--ink) / 0.06), transparent 60%)",
          }}
        />
        <div aria-hidden className="pointer-events-none absolute left-5 top-5 h-8 w-8">
          <div className="absolute inset-x-0 top-0 h-px bg-outline" />
          <div className="absolute inset-y-0 left-0 w-px bg-outline" />
        </div>

        <div className="relative p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink-soft">
                <BookOpen className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute">
                  {t("myApps.edit.deployTokens.instructions.eyebrow")}
                </div>
                <h3
                  id="deploy-token-instructions-title"
                  className="mt-1 text-lg font-bold leading-tight tracking-tight text-ink"
                >
                  {t("myApps.edit.deployTokens.instructions.title")}
                </h3>
              </div>
            </div>
            <button
              ref={closeBtnRef}
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill text-ink-mute transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-soft">
            {t("myApps.edit.deployTokens.instructions.body")}
          </p>

          {/* Specification block — method / URL / auth / body. Two-
              column grid with a mono-weight value column reads like
              an API reference table. */}
          <dl className="mt-5 grid gap-2.5 rounded-2xl border border-outline-soft bg-surface-2/40 p-4">
            <SpecRow
              label={t("myApps.edit.deployTokens.instructions.method")}
              value="POST"
            />
            <SpecRow
              label={t("myApps.edit.deployTokens.instructions.url")}
              value={url}
              copyable
            />
            <SpecRow
              label={t("myApps.edit.deployTokens.instructions.auth")}
              value={`Authorization: Bearer ${PLACEHOLDER}`}
              copyable
            />
            <SpecRow
              label={t("myApps.edit.deployTokens.instructions.body_")}
              value={`multipart/form-data — field name: file`}
            />
          </dl>

          {/* Token-callout — explicit reminder that <YOUR_TOKEN> isn't
              a literal you can copy, you need to substitute the one
              you minted (and we can't show it again). */}
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-accent/40 bg-accent-container/30 px-3 py-2 text-[11px] leading-relaxed text-ink-soft">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-on-container" />
            <span>{t("myApps.edit.deployTokens.instructions.tokenNotice")}</span>
          </div>

          <div className="mt-5">
            <div className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
              {t("myApps.edit.deployTokens.instructions.snippets")}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              <SnippetTab active={tab === "curl"} onClick={() => setTab("curl")}>curl</SnippetTab>
              <SnippetTab active={tab === "ghactions"} onClick={() => setTab("ghactions")}>GitHub Actions</SnippetTab>
              <SnippetTab active={tab === "gitlabci"} onClick={() => setTab("gitlabci")}>GitLab CI</SnippetTab>
            </div>
            <CredentialBlock value={snippets[tab]} multiline />
          </div>

          <div className="mt-5 flex items-center justify-end border-t border-outline-soft pt-4">
            <Button type="button" variant="filled" size="sm" onClick={onClose}>
              {t("common.close")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}


function SpecRow({
  label,
  value,
  copyable,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }
  return (
    <div className="grid grid-cols-[80px_1fr_auto] items-center gap-2">
      <dt className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">{label}</dt>
      <dd className="break-all font-mono text-[11px] text-ink">{value}</dd>
      {copyable && (
        <button
          type="button"
          onClick={copy}
          aria-label="Copy"
          className="flex h-6 w-6 items-center justify-center rounded-pill text-ink-mute transition-colors hover:bg-surface hover:text-ink"
        >
          {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
        </button>
      )}
    </div>
  );
}
