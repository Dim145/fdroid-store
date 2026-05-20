"use client";

import { Gauge, Image as ImageIcon, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, REPO_URL, type KeystoreInfo, type RepoConfigInfo } from "@/lib/api";
import { useRepoStore } from "@/lib/repo-store";

export default function AdminRepoPage() {
  const { t } = useTranslation();
  const refreshGlobalRepo = useRepoStore((s) => s.refresh);
  const [repo, setRepo] = useState<RepoConfigInfo | null>(null);
  const [keystore, setKeystore] = useState<KeystoreInfo | null>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [addr, setAddr] = useState("");
  const [mirrors, setMirrors] = useState<string[]>([]);
  const [newMirror, setNewMirror] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [uploadingIcon, setUploadingIcon] = useState(false);

  async function refresh() {
    try {
      const [r, k] = await Promise.all([api.admin.repo(), api.setup.keystoreInfo()]);
      setRepo(r); setKeystore(k);
      setName(r.name); setDesc(r.description || ""); setAddr(r.address);
      setMirrors(r.mirrors || []);
    } catch (e) { setErr(e instanceof Error ? e.message : t("admin.repo.loadFailed")); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setMsg(null);
    try {
      await api.admin.updateRepo({ name, description: desc, address: addr, mirrors });
      setMsg(t("admin.repo.saved"));
      await Promise.all([refresh(), refreshGlobalRepo()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("admin.repo.saveFailed"));
    }
  }

  function addMirror() {
    const trimmed = newMirror.trim();
    if (!trimmed) return;
    if (mirrors.includes(trimmed)) { setNewMirror(""); return; }
    setMirrors([...mirrors, trimmed]);
    setNewMirror("");
  }
  function removeMirror(url: string) {
    setMirrors(mirrors.filter((m) => m !== url));
  }
  async function uploadIcon(file: File) {
    setErr(null); setMsg(null); setUploadingIcon(true);
    try {
      await api.admin.uploadRepoIcon(file);
      setMsg(t("admin.repo.iconUploaded"));
      await refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : t("admin.repo.iconUploadFailed")); }
    finally { setUploadingIcon(false); }
  }
  function iconUrl(): string | null {
    if (!repo?.icon_path) return null;
    const basename = repo.icon_path.split("/").pop();
    if (!basename) return null;
    const base = (repo.address || REPO_URL).replace(/\/$/, "");
    return `${base}/icons/${basename}?v=${repo.last_index_version}`;
  }

  if (!repo) {
    return <p className="text-sm text-ink-mute">{t("admin.repo.loading")}</p>;
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="eyebrow">{t("admin.eyebrow")}</div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">{t("admin.repo.title")}</h1>
      </header>

      {msg && <p className="rounded-xl border border-primary bg-primary-container px-3 py-2 text-sm text-primary-on-container">{msg}</p>}
      {err && <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{err}</p>}

      <section className="surface p-6">
        <h2 className="mb-4 text-lg font-bold tracking-tight text-ink">{t("admin.repo.publicMetadata")}</h2>
        <form onSubmit={save} className="grid gap-4 md:grid-cols-2">
          <Field label={t("admin.repo.repoName")} htmlFor="rn" className="md:col-span-2">
            <Input id="rn" required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("admin.repo.description")} htmlFor="rd" className="md:col-span-2">
            <Input id="rd" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </Field>
          <Field label={t("admin.repo.publicAddress")} htmlFor="ra" className="md:col-span-2">
            <Input id="ra" required value={addr} onChange={(e) => setAddr(e.target.value)} />
            <p className="text-xs text-ink-mute">{t("admin.repo.publicAddressHint")}</p>
          </Field>
          <div className="md:col-span-2 flex justify-end">
            <Button type="submit" variant="filled">{t("admin.repo.saveAndReindex")}</Button>
          </div>
        </form>
      </section>

      <section className="surface p-6">
        <h2 className="mb-4 text-lg font-bold tracking-tight text-ink">{t("admin.repo.iconSection")}</h2>
        <div className="flex flex-wrap items-center gap-5">
          {iconUrl() && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={iconUrl()!} alt="repo icon" className="h-20 w-20 rounded-2xl bg-surface-2 object-cover shadow-e1" />
          )}
          <div className="flex-1">
            <label className="inline-flex">
              <span className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-pill bg-primary-container px-4 text-sm font-semibold text-primary-on-container hover:brightness-[1.04]">
                <ImageIcon className="h-4 w-4" /> {t("admin.repo.uploadIcon")}
              </span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={uploadingIcon}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadIcon(f); e.target.value = ""; }}
                className="sr-only"
              />
            </label>
            <p className="mt-2 font-mono text-[11px] text-ink-mute">{repo.icon_path || "—"}</p>
          </div>
        </div>
      </section>

      <section className="surface p-6">
        <h2 className="mb-1 text-lg font-bold tracking-tight text-ink">{t("admin.repo.mirrors")}</h2>
        <p className="mb-4 text-sm text-ink-soft">
          {t("admin.repo.mirrorsBody")}
        </p>
        <ul className="space-y-2">
          {mirrors.length === 0 && (
            <li className="rounded-xl border border-dashed border-outline px-4 py-6 text-center italic text-ink-mute">
              {t("admin.repo.noMirrors")}
            </li>
          )}
          {mirrors.map((m) => (
            <li key={m} className="flex items-center gap-2 rounded-xl border border-outline-soft bg-surface px-3 py-2">
              <code className="min-w-0 flex-1 select-all truncate font-mono text-xs text-ink">{m}</code>
              <Button type="button" size="sm" variant="outlined" onClick={() => removeMirror(m)}>
                <Trash2 className="h-3.5 w-3.5" /> {t("admin.repo.remove")}
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-4 grid gap-2 md:grid-cols-[1fr_auto]">
          <Input
            placeholder={t("admin.repo.mirrorPlaceholder")}
            value={newMirror}
            onChange={(e) => setNewMirror(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addMirror(); } }}
          />
          <Button type="button" variant="tonal" onClick={addMirror}>
            <Plus className="h-4 w-4" /> {t("admin.repo.addMirror")}
          </Button>
        </div>
      </section>

      <section className="surface p-6">
        <h2 className="mb-1 flex items-center gap-2 text-lg font-bold tracking-tight text-ink">
          <Gauge className="h-5 w-5" /> {t("admin.repo.quotas")}
        </h2>
        <p className="mb-4 text-sm text-ink-soft">{t("admin.repo.quotasBody")}</p>
        <QuotaDefaults
          repo={repo}
          onSaved={(updated) => {
            setRepo(updated);
            setMsg(t("admin.repo.saved"));
          }}
        />
      </section>

      <section className="surface p-6">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-bold tracking-tight text-ink">
          <KeyRound className="h-5 w-5" /> {t("admin.repo.signingKey")}
        </h2>
        {keystore?.present ? (
          <dl className="grid gap-3 md:grid-cols-2">
            <Detail label={t("admin.repo.alias")} value={keystore.alias} mono />
            <Detail label={t("admin.repo.validUntil")} value={keystore.not_after} />
            <div className="md:col-span-2">
              <div className="text-[10px] uppercase tracking-wider text-ink-mute">{t("admin.repo.fingerprint")}</div>
              <code className="mt-1 block break-all font-mono text-[11px] text-ink">{keystore.fingerprint_sha256}</code>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-danger">{t("admin.repo.noKeystore")}</p>
        )}
      </section>

      <section className="surface p-6">
        <h2 className="mb-4 text-lg font-bold tracking-tight text-ink">{t("admin.repo.indexState")}</h2>
        <dl className="grid gap-3 md:grid-cols-2">
          <Detail label={t("admin.repo.lastIndexVersion")} value={String(repo.last_index_version)} mono />
          <Detail label={t("admin.repo.lastIndexed")} value={repo.last_indexed_at} />
        </dl>
        <div className="mt-4">
          <Button variant="outlined" onClick={() => api.admin.reindex().then(() => setMsg(t("admin.repo.reindexQueued")))}>
            <RefreshCw className="h-4 w-4" /> {t("admin.repo.triggerReindex")}
          </Button>
        </div>
      </section>
    </div>
  );
}

function Field({
  label, htmlFor, className, children,
}: { label: string; htmlFor?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`space-y-1.5 ${className || ""}`}>
      <Label htmlFor={htmlFor} className="text-sm font-medium text-ink-soft">{label}</Label>
      {children}
    </div>
  );
}
function Detail({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-mute">{label}</div>
      <div className={`mt-0.5 text-sm ${mono ? "font-mono" : ""}`}>
        {value || <Badge variant="soft">—</Badge>}
      </div>
    </div>
  );
}


/* Repo-wide default quota editor. Empty input = no cap (unlimited).
 * A per-user override still wins over whatever we set here. */
function QuotaDefaults({
  repo,
  onSaved,
}: {
  repo: RepoConfigInfo;
  onSaved: (updated: RepoConfigInfo) => void;
}) {
  const { t } = useTranslation();
  const [apps, setApps] = useState<string>(
    repo.default_quota_max_apps != null ? String(repo.default_quota_max_apps) : "",
  );
  const [storageMB, setStorageMB] = useState<string>(
    repo.default_quota_max_storage_bytes != null
      ? String(Math.floor(repo.default_quota_max_storage_bytes / (1024 * 1024)))
      : "",
  );
  const [monthly, setMonthly] = useState<string>(
    repo.default_quota_max_apks_per_month != null
      ? String(repo.default_quota_max_apks_per_month)
      : "",
  );
  const [maxVersions, setMaxVersions] = useState<string>(
    repo.default_max_versions_per_app != null
      ? String(repo.default_max_versions_per_app)
      : "",
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function parseOrNull(s: string): number | null {
    const trimmed = s.trim();
    if (!trimmed) return null;
    const n = parseInt(trimmed, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    const payload: Partial<RepoConfigInfo> = {};
    const a = parseOrNull(apps);
    if (a == null) payload.quota_reset_apps = true;
    else payload.default_quota_max_apps = a;

    const s = parseOrNull(storageMB);
    if (s == null) payload.quota_reset_storage_bytes = true;
    else payload.default_quota_max_storage_bytes = s * 1024 * 1024;

    const m = parseOrNull(monthly);
    if (m == null) payload.quota_reset_apks_per_month = true;
    else payload.default_quota_max_apks_per_month = m;

    const v = parseOrNull(maxVersions);
    if (v == null) payload.quota_reset_max_versions_per_app = true;
    else payload.default_max_versions_per_app = v;

    try {
      const updated = await api.admin.updateRepo(payload);
      onSaved(updated);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("admin.repo.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="grid gap-3 md:grid-cols-4">
      <Field label={t("admin.repo.quotaApps")} htmlFor="q-d-apps">
        <Input
          id="q-d-apps"
          type="number"
          min={0}
          placeholder={t("admin.repo.quotaUnlimited")}
          value={apps}
          onChange={(e) => setApps(e.target.value)}
        />
      </Field>
      <Field label={t("admin.repo.quotaStorage")} htmlFor="q-d-storage">
        <Input
          id="q-d-storage"
          type="number"
          min={0}
          placeholder={t("admin.repo.quotaUnlimited")}
          value={storageMB}
          onChange={(e) => setStorageMB(e.target.value)}
        />
      </Field>
      <Field label={t("admin.repo.quotaMonthly")} htmlFor="q-d-monthly">
        <Input
          id="q-d-monthly"
          type="number"
          min={0}
          placeholder={t("admin.repo.quotaUnlimited")}
          value={monthly}
          onChange={(e) => setMonthly(e.target.value)}
        />
      </Field>
      <Field label={t("admin.repo.maxVersions")} htmlFor="q-d-maxv">
        <Input
          id="q-d-maxv"
          type="number"
          min={0}
          placeholder={t("admin.repo.quotaUnlimited")}
          value={maxVersions}
          onChange={(e) => setMaxVersions(e.target.value)}
        />
      </Field>
      {err && (
        <p className="md:col-span-4 rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">
          {err}
        </p>
      )}
      <p className="md:col-span-4 text-[11px] text-ink-mute">
        {t("admin.repo.maxVersionsHint")}
      </p>
      <div className="md:col-span-4 flex justify-end">
        <Button type="submit" variant="filled" disabled={busy}>
          {busy ? t("common.saving") : t("admin.repo.saveQuotas")}
        </Button>
      </div>
    </form>
  );
}
