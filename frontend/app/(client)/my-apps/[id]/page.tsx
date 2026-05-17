"use client";

import { ArrowLeft, Eye, ImagePlus, RotateCcw, ShieldAlert, Trash2, Upload, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Fragment, useEffect, useState } from "react";

import { AppIcon } from "@/components/app-icon";
import { AppPermissions } from "@/components/app-permissions";
import { AuthGuard } from "@/components/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, mediaUrl, type Apk, type AppDetail } from "@/lib/api";
import { cn, formatBytes, formatDate } from "@/lib/utils";

function ManageAppInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [license, setLicense] = useState("");
  const [website, setWebsite] = useState("");
  const [sourceCode, setSourceCode] = useState("");
  const [issueTracker, setIssueTracker] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const [donate, setDonate] = useState("");
  const [liberapay, setLiberapay] = useState("");
  const [bitcoin, setBitcoin] = useState("");
  const [openCollective, setOpenCollective] = useState("");
  const [translation, setTranslation] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [editingChangelog, setEditingChangelog] = useState<{ apkId: string; text: string } | null>(null);
  const [savingChangelog, setSavingChangelog] = useState(false);
  const [savingApkId, setSavingApkId] = useState<string | null>(null);

  async function load() {
    try {
      const detail = await api.apps.get(id);
      setApp(detail);
      setName(detail.name);
      setSummary(detail.summary || "");
      setDescription(detail.description || "");
      setLicense(detail.license || "");
      setWebsite(detail.website || "");
      setSourceCode(detail.source_code || "");
      setIssueTracker(detail.issue_tracker || "");
      setAuthorName(detail.author_name || "");
      setAuthorEmail(detail.author_email || "");
      setDonate(detail.donate || "");
      setLiberapay(detail.liberapay || "");
      setBitcoin(detail.bitcoin || "");
      setOpenCollective(detail.open_collective || "");
      setTranslation(detail.translation || "");
      setVisibility(detail.visibility);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load app");
    }
  }
  useEffect(() => { if (id) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!app) return;
    setSaving(true); setError(null); setMsg(null);
    try {
      await api.apps.update(app.id, {
        name,
        summary: summary || undefined,
        description: description || undefined,
        license: license || undefined,
        website: website || undefined,
        source_code: sourceCode || undefined,
        issue_tracker: issueTracker || undefined,
        author_name: authorName || undefined,
        author_email: authorEmail || undefined,
        donate: donate || undefined,
        liberapay: liberapay || undefined,
        bitcoin: bitcoin || undefined,
        open_collective: openCollective || undefined,
        translation: translation || undefined,
        visibility,
      });
      setMsg("Saved.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally { setSaving(false); }
  }
  async function uploadVersion(file: File) {
    if (!app) return;
    setUploading(true); setError(null); setMsg(null);
    try {
      await api.apps.uploadApk(app.id, file);
      setMsg("New version uploaded.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally { setUploading(false); }
  }
  async function deleteApk(apk: Apk) {
    if (!confirm(`Delete version ${apk.version_name} (${apk.version_code})?`)) return;
    try { await api.apps.deleteApk(apk.id); setMsg("Version deleted."); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Delete failed"); }
  }
  async function deleteApp() {
    if (!app) return;
    if (!confirm(`Delete ${app.name} and ALL versions? Permanent.`)) return;
    try { await api.apps.remove(app.id); router.replace("/my-apps"); }
    catch (e) { setError(e instanceof Error ? e.message : "Delete failed"); }
  }
  async function saveChangelog() {
    if (!editingChangelog) return;
    setError(null); setMsg(null); setSavingChangelog(true);
    try {
      await api.apps.updateApk(editingChangelog.apkId, { whats_new: editingChangelog.text || null });
      setMsg("Changelog saved.");
      setEditingChangelog(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally { setSavingChangelog(false); }
  }
  async function clearChangelog(apkId: string) {
    setSavingChangelog(true);
    try {
      await api.apps.updateApk(apkId, { whats_new: null });
      setMsg("Changelog cleared.");
      setEditingChangelog(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Clear failed");
    } finally { setSavingChangelog(false); }
  }
  async function uploadCustomIcon(file: File) {
    if (!app) return;
    setError(null); setMsg(null);
    try { await api.apps.uploadIcon(app.id, file); setMsg("Custom icon uploaded."); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Icon upload failed"); }
  }
  async function uploadFeatureGraphic(file: File) {
    if (!app) return;
    setError(null); setMsg(null);
    try { await api.apps.uploadFeatureGraphic(app.id, file); setMsg("Featured graphic uploaded."); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Upload failed"); }
  }
  async function clearFeatureGraphic() {
    if (!app) return;
    if (!confirm("Remove the featured graphic?")) return;
    setError(null); setMsg(null);
    try { await api.apps.deleteFeatureGraphic(app.id); setMsg("Featured graphic removed."); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Delete failed"); }
  }
  async function toggleApkAntiFeature(apk: Apk, flag: string) {
    // Toggle locally then save. Optimistic + reload to stay in sync with the
    // server (the index rebuild is async so we want the canonical state back).
    const current = apk.anti_features || [];
    const next = current.includes(flag)
      ? current.filter((f) => f !== flag)
      : [...current, flag];
    setSavingApkId(apk.id); setError(null); setMsg(null);
    try {
      await api.apps.updateApk(apk.id, { anti_features: next });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingApkId(null);
    }
  }
  async function revertIcon() {
    if (!app) return;
    if (!confirm("Revert to the icon extracted from the latest APK?")) return;
    setError(null); setMsg(null);
    try { await api.apps.revertIcon(app.id); setMsg("Icon reverted."); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Revert failed"); }
  }
  async function uploadScreenshots(files: FileList | null) {
    if (!app || !files || files.length === 0) return;
    setError(null); setMsg(null);
    try {
      await api.apps.uploadScreenshots(app.id, Array.from(files));
      setMsg(`${files.length} screenshot${files.length === 1 ? "" : "s"} uploaded.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    }
  }
  async function deleteScreenshot(screenshotId: string) {
    if (!app) return;
    if (!confirm("Delete this screenshot?")) return;
    try { await api.apps.deleteScreenshot(app.id, screenshotId); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Delete failed"); }
  }

  if (!app && !error) {
    return <div className="flex justify-center py-24"><Spinner /></div>;
  }
  if (!app) {
    return <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{error}</p>;
  }

  const published = [...app.apks].filter((a) => a.status === "published").sort((a, b) => b.version_code - a.version_code);
  const latest = published[0];

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="surface flex flex-wrap items-start gap-5 p-6">
        <AppIcon iconPath={app.icon_path} name={app.name} size={88} version={app.updated_at} className="shadow-e2" />
        <div className="min-w-0 flex-1">
          <Link href="/my-apps" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft hover:text-ink">
            <ArrowLeft className="h-4 w-4" /> My apps
          </Link>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">{app.name}</h1>
          <p className="mt-0.5 font-mono text-xs text-ink-mute">{app.package_name}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant={app.visibility === "private" ? "accent" : "outline"}>{app.visibility}</Badge>
            <Badge variant={app.status === "published" ? "primary" : "soft"}>{app.status.replace("_", " ")}</Badge>
          </div>
        </div>
        <Button asChild variant="outlined" size="md">
          <Link href={`/apps/${app.package_name}`}>
            <Eye className="h-4 w-4" /> Public page
          </Link>
        </Button>
      </header>

      {msg && (
        <p className="rounded-xl border border-primary bg-primary-container px-3 py-2 text-sm text-primary-on-container">{msg}</p>
      )}
      {error && (
        <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{error}</p>
      )}

      {/* ──── Listing ──── */}
      <Section step="01" title="Listing" subtitle="Package name is locked to the signing certificate.">
        <form onSubmit={save} className="grid gap-4 md:grid-cols-2">
          <FormField label="Title" htmlFor="name" className="md:col-span-2">
            <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label="Package (locked)" htmlFor="pkg">
            <Input id="pkg" disabled value={app.package_name} className="font-mono text-xs" />
          </FormField>
          <FormField label="Visibility" htmlFor="vis">
            <select
              id="vis"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as "public" | "private")}
              className="h-12 w-full rounded-xl border border-outline bg-surface px-3 text-sm focus:border-primary focus:outline-none"
            >
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          </FormField>
          <FormField label="Summary" htmlFor="sum" className="md:col-span-2">
            <Input id="sum" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={255} />
          </FormField>
          <FormField label="Description" htmlFor="desc" className="md:col-span-2">
            <textarea
              id="desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              className="w-full rounded-xl border border-outline bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
          </FormField>
          <FormField label="Author" htmlFor="author"><Input id="author" value={authorName} onChange={(e) => setAuthorName(e.target.value)} /></FormField>
          <FormField label="License" htmlFor="lic"><Input id="lic" value={license} onChange={(e) => setLicense(e.target.value)} /></FormField>
          <FormField label="Website" htmlFor="web"><Input id="web" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} /></FormField>
          <FormField label="Source code" htmlFor="src"><Input id="src" type="url" value={sourceCode} onChange={(e) => setSourceCode(e.target.value)} /></FormField>
          <FormField label="Issue tracker" htmlFor="issue" className="md:col-span-2">
            <Input id="issue" type="url" value={issueTracker} onChange={(e) => setIssueTracker(e.target.value)} />
          </FormField>
          <FormField label="Author email" htmlFor="aemail">
            <Input id="aemail" type="email" value={authorEmail} onChange={(e) => setAuthorEmail(e.target.value)} />
          </FormField>
          <FormField label="Translation URL" htmlFor="trans">
            <Input id="trans" type="url" placeholder="https://weblate.example.org/…" value={translation} onChange={(e) => setTranslation(e.target.value)} />
          </FormField>
          <FormField label="Donate URL" htmlFor="don">
            <Input id="don" type="url" value={donate} onChange={(e) => setDonate(e.target.value)} />
          </FormField>
          <FormField label="Liberapay" htmlFor="lib">
            <Input id="lib" type="url" placeholder="https://liberapay.com/you" value={liberapay} onChange={(e) => setLiberapay(e.target.value)} />
          </FormField>
          <FormField label="Open Collective" htmlFor="oc">
            <Input id="oc" type="url" placeholder="https://opencollective.com/you" value={openCollective} onChange={(e) => setOpenCollective(e.target.value)} />
          </FormField>
          <FormField label="Bitcoin" htmlFor="btc">
            <Input id="btc" placeholder="bc1q… or bitcoin:bc1q…" value={bitcoin} onChange={(e) => setBitcoin(e.target.value)} />
          </FormField>
          <div className="md:col-span-2 flex justify-end">
            <Button type="submit" variant="filled" size="lg" disabled={saving}>
              {saving ? "Saving…" : "Save listing"}
            </Button>
          </div>
        </form>
      </Section>

      {/* ──── Icon ──── */}
      <Section step="02" title="Cover art" subtitle="Auto-extracted from the latest APK. Upload a custom one to lock it.">
        <div className="flex flex-wrap items-center gap-5">
          <AppIcon iconPath={app.icon_path} name={app.name} size={96} version={app.updated_at} className="shadow-e2" />
          <div className="flex-1 space-y-2">
            <Badge variant={app.icon_is_custom ? "primary" : "outline"}>
              {app.icon_is_custom ? "custom" : "auto-extracted"}
            </Badge>
            {app.icon_path && (
              <div className="font-mono text-[11px] text-ink-mute">{app.icon_path}</div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex">
                <span className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-pill bg-primary-container px-4 text-sm font-semibold text-primary-on-container hover:brightness-[1.04]">
                  <ImagePlus className="h-4 w-4" /> Upload custom
                </span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadCustomIcon(f); e.target.value = ""; }}
                  className="sr-only"
                />
              </label>
              {app.icon_is_custom && (
                <Button type="button" variant="outlined" size="md" onClick={revertIcon}>
                  <RotateCcw className="h-4 w-4" /> Revert to auto
                </Button>
              )}
            </div>
          </div>
        </div>
      </Section>

      {/* ──── Featured graphic ──── */}
      <Section
        step="2b"
        title="Featured graphic"
        subtitle="Wide banner the F-Droid client shows above the description. 1024×500 max, JPEG/PNG/WebP."
      >
        <div className="flex flex-wrap items-center gap-5">
          {app.feature_graphic_path ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={mediaUrl(app.feature_graphic_path) || ""}
              alt="featured graphic"
              className="h-32 w-auto rounded-2xl border border-outline-soft bg-surface-2 object-cover shadow-e1"
            />
          ) : (
            <div className="flex h-32 w-64 items-center justify-center rounded-2xl border border-dashed border-outline bg-surface-2 text-xs italic text-ink-mute">
              No banner yet
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex">
              <span className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-pill bg-primary-container px-4 text-sm font-semibold text-primary-on-container hover:brightness-[1.04]">
                <ImagePlus className="h-4 w-4" /> Upload banner
              </span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFeatureGraphic(f); e.target.value = ""; }}
                className="sr-only"
              />
            </label>
            {app.feature_graphic_path && (
              <Button type="button" variant="outlined" size="md" onClick={clearFeatureGraphic}>
                <Trash2 className="h-4 w-4" /> Remove
              </Button>
            )}
          </div>
        </div>
      </Section>

      {/* ──── Screenshots ──── */}
      <Section step="03" title="Screenshots" subtitle="PNG / JPEG / WebP, resized to 1080×1920 max.">
        <label className="inline-flex">
          <span className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-pill bg-primary-container px-4 text-sm font-semibold text-primary-on-container hover:brightness-[1.04]">
            <ImagePlus className="h-4 w-4" /> Add screenshots
          </span>
          <input
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => { uploadScreenshots(e.target.files); e.target.value = ""; }}
            className="sr-only"
          />
        </label>
        {app.screenshots.length === 0 ? (
          <p className="mt-4 text-sm italic text-ink-mute">No screenshots yet.</p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-3">
            {[...app.screenshots].sort((a, b) => a.display_order - b.display_order).map((s) => {
              const url = mediaUrl(s.storage_key);
              if (!url) return null;
              return (
                <div key={s.id} className="group relative overflow-hidden rounded-xl border border-outline-soft bg-surface-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt="screenshot" className="h-44 w-auto object-contain" />
                  <button
                    type="button"
                    onClick={() => deleteScreenshot(s.id)}
                    aria-label="Delete screenshot"
                    className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-pill bg-danger text-danger-fg opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={2.6} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* ──── Permissions ──── */}
      {latest && (
        <Section step="04" title="Permissions" subtitle={`Declared by v${latest.version_name} (${latest.version_code})`}>
          <AppPermissions permissions={latest.permissions} />
        </Section>
      )}

      {/* ──── Versions ──── */}
      <Section step="05" title="Versions" subtitle="Upload a new APK to publish a new version. The signer must match.">
        <label className="mb-4 inline-flex">
          <span className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-pill bg-primary px-4 text-sm font-semibold text-primary-fg shadow-e1 hover:brightness-[1.04]">
            <Upload className="h-4 w-4" /> Upload new version
          </span>
          <input
            type="file"
            accept=".apk,application/vnd.android.package-archive"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadVersion(f); e.target.value = ""; }}
            disabled={uploading}
            className="sr-only"
          />
        </label>
        {uploading && (
          <span className="ml-3 text-sm text-ink-soft">Uploading…</span>
        )}

        <ul className="space-y-2">
          {app.apks.length === 0 ? (
            <li className="rounded-xl border border-dashed border-outline px-4 py-10 text-center italic text-ink-mute">
              No versions yet.
            </li>
          ) : (
            app.apks.map((apk) => {
              const isEditing = editingChangelog?.apkId === apk.id;
              return (
                <Fragment key={apk.id}>
                  <li className="surface flex flex-wrap items-center gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-base font-semibold text-ink">v{apk.version_name}</span>
                        <Badge variant={apk.status === "published" ? "primary" : "soft"}>
                          {apk.status.replace("_", " ")}
                        </Badge>
                      </div>
                      <div className="mt-0.5 text-xs text-ink-mute">
                        Code {apk.version_code} · {formatBytes(apk.size_bytes)} · SDK {apk.min_sdk}–{apk.target_sdk}
                      </div>
                      {apk.whats_new ? (
                        <p
                          title={apk.whats_new}
                          className="mt-1 max-w-md truncate text-xs text-ink-soft"
                        >
                          ★ {apk.whats_new}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs italic text-ink-mute">No changelog</p>
                      )}
                      <AntiFeatureChips
                        apk={apk}
                        disabled={savingApkId === apk.id}
                        onToggle={(flag) => toggleApkAntiFeature(apk, flag)}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outlined"
                        onClick={() => (isEditing ? setEditingChangelog(null) : setEditingChangelog({ apkId: apk.id, text: apk.whats_new ?? "" }))}
                      >
                        {isEditing ? "Close" : apk.whats_new ? "Edit notes" : "Add notes"}
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => deleteApk(apk)}>
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </Button>
                    </div>
                  </li>
                  {isEditing && (
                    <li className="rounded-2xl bg-surface-2 p-4">
                      <Label className="text-xs font-medium text-ink-soft">
                        Release notes for v{apk.version_name} ({apk.version_code})
                      </Label>
                      <textarea
                        rows={5}
                        value={editingChangelog!.text}
                        onChange={(e) => setEditingChangelog({ apkId: apk.id, text: e.target.value })}
                        className="mt-2 w-full rounded-xl border border-outline bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
                        placeholder="• What changed…"
                      />
                      <div className="mt-2 flex gap-2">
                        <Button size="md" variant="filled" onClick={saveChangelog} disabled={savingChangelog}>
                          {savingChangelog ? "Saving…" : "Save"}
                        </Button>
                        <Button size="md" variant="ghost" onClick={() => setEditingChangelog(null)}>Cancel</Button>
                        {apk.whats_new && (
                          <Button size="md" variant="text" className="ml-auto text-danger" onClick={() => clearChangelog(apk.id)}>
                            Clear
                          </Button>
                        )}
                      </div>
                    </li>
                  )}
                </Fragment>
              );
            })
          )}
        </ul>
      </Section>

      {/* ──── Danger zone ──── */}
      <section className="rounded-3xl border-2 border-danger/40 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold tracking-tight text-danger">Danger zone</h2>
            <p className="text-sm text-ink-soft">Deletes the app and all of its versions, icons and screenshots.</p>
          </div>
          <Button variant="danger" onClick={deleteApp}>
            <Trash2 className="h-4 w-4" /> Delete release
          </Button>
        </div>
      </section>
    </div>
  );
}

function Section({
  step,
  title,
  subtitle,
  children,
}: {
  step: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="surface p-6">
      <header className="mb-5 flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-pill bg-primary-container font-mono text-sm font-bold text-primary-on-container">
          {step}
        </span>
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink">{title}</h2>
          {subtitle && <p className="text-sm text-ink-mute">{subtitle}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}

function FormField({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-sm font-medium text-ink-soft">{label}</Label>
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-outline-soft border-t-primary" role="status" aria-label="Loading" />
  );
}

// The set the F-Droid client recognises and renders as warning badges. Order
// roughly matches how upstream metadata lists them, with the security/privacy
// ones first.
const KNOWN_ANTI_FEATURES = [
  "Tracking",
  "NonFreeNet",
  "NonFreeAdd",
  "KnownVuln",
  "NoSourceSince",
  "NonFreeAssets",
  "NonFreeDep",
  "UpstreamNonFree",
  "DisabledAlgorithm",
  "NSFW",
] as const;

function AntiFeatureChips({
  apk,
  disabled,
  onToggle,
}: {
  apk: Apk;
  disabled: boolean;
  onToggle: (flag: string) => void;
}) {
  const active = new Set(apk.anti_features || []);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <ShieldAlert className="h-3.5 w-3.5 text-ink-mute" />
      <span className="mr-1 text-[10px] uppercase tracking-wider text-ink-mute">
        Anti-features
      </span>
      {KNOWN_ANTI_FEATURES.map((flag) => {
        const on = active.has(flag);
        return (
          <button
            key={flag}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(flag)}
            className={cn(
              "rounded-pill border px-2 py-0.5 text-[10px] font-semibold transition-colors",
              on
                ? "border-accent bg-accent-container text-accent-on-container"
                : "border-outline-soft bg-surface text-ink-mute hover:border-outline hover:text-ink",
              disabled && "opacity-50",
            )}
          >
            {flag}
          </button>
        );
      })}
    </div>
  );
}

export default function ManageAppPage() {
  return (
    <AuthGuard>
      <ManageAppInner />
    </AuthGuard>
  );
}
