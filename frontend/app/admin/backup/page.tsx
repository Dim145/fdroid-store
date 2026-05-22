"use client";

import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, BACKUP_COMPONENTS, type BackupComponent, type BackupJob } from "@/lib/api";
import { toast } from "@/lib/toast-store";
import { cn, formatDate } from "@/lib/utils";

/** Poll cadence — the worker progress callback persists at every phase
 *  boundary, which is more frequent than the bar can render anyway.
 *  2 s keeps the network noise low while still feeling responsive. */
const POLL_MS = 2000;

export default function AdminBackupPage() {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const res = await api.backup.list();
      setJobs(res.items);
    } catch (e) {
      toast.error(t("admin.backup.list.failed"), e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Poll while any job is active. Stops the timer when the list goes
  // fully quiescent so we're not hammering the API at rest.
  useEffect(() => {
    const active = jobs.some((j) => j.status === "pending" || j.status === "running");
    if (!active) return;
    const tick = setInterval(() => {
      void reload();
    }, POLL_MS);
    return () => clearInterval(tick);
  }, [jobs, reload]);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-extrabold tracking-tight text-ink">
          <Archive className="h-6 w-6" /> {t("admin.backup.title")}
        </h1>
        <p className="max-w-3xl text-sm text-ink-soft">
          {t("admin.backup.subtitle")}
        </p>
      </header>

      <BackupCreateCard onSubmitted={reload} />
      <BackupRestoreCard onSubmitted={reload} />
      <BackupHistoryCard
        jobs={jobs}
        loading={loading}
        onChange={reload}
      />
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Create backup                                                              */
/* -------------------------------------------------------------------------- */

function BackupCreateCard({ onSubmitted }: { onSubmitted: () => Promise<void> }) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  // All four checked by default. Unchecking the last one is allowed by
  // the UI (we surface an inline message), but the submit handler
  // rejects an empty selection so the server doesn't waste a job slot
  // on a no-op tarball.
  const [components, setComponents] = useState<Set<BackupComponent>>(
    () => new Set<BackupComponent>(BACKUP_COMPONENTS),
  );
  const [busy, setBusy] = useState(false);

  function toggle(c: BackupComponent) {
    setComponents((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (passphrase.length < 12) {
      toast.error(t("admin.backup.create.passphraseShort"));
      return;
    }
    if (passphrase !== confirmPassphrase) {
      toast.error(t("admin.backup.create.passphraseMismatch"));
      return;
    }
    if (components.size === 0) {
      toast.error(t("admin.backup.components.noneSelected"));
      return;
    }
    setBusy(true);
    try {
      await api.backup.create(passphrase, [...components]);
      toast.success(t("admin.backup.create.enqueued"));
      setPassphrase("");
      setConfirmPassphrase("");
      await onSubmitted();
    } catch (e) {
      toast.error(t("admin.backup.create.failed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="surface p-6">
      <header className="mb-4 flex items-center gap-2">
        <Download className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-bold tracking-tight text-ink">
          {t("admin.backup.create.title")}
        </h2>
      </header>
      <p className="mb-4 max-w-3xl text-sm text-ink-soft">
        {t("admin.backup.create.body")}
      </p>
      <form onSubmit={onCreate} className="grid gap-3 sm:grid-cols-2 sm:items-end">
        <div>
          <Label htmlFor="bk-passphrase" className="text-[10px] uppercase tracking-wider text-ink-mute">
            {t("admin.backup.create.passphrase")}
          </Label>
          <Input
            id="bk-passphrase"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
            placeholder={t("admin.backup.create.passphrasePlaceholder")}
            minLength={12}
            maxLength={512}
          />
        </div>
        <div>
          <Label htmlFor="bk-confirm" className="text-[10px] uppercase tracking-wider text-ink-mute">
            {t("admin.backup.create.passphraseConfirm")}
          </Label>
          <Input
            id="bk-confirm"
            type="password"
            value={confirmPassphrase}
            onChange={(e) => setConfirmPassphrase(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
            minLength={12}
            maxLength={512}
          />
        </div>
        <div className="sm:col-span-2">
          <p className="mb-2 text-[10px] uppercase tracking-wider text-ink-mute">
            {t("admin.backup.components.label")}
          </p>
          <ComponentPicker selected={components} onToggle={toggle} />
        </div>
        <div className="sm:col-span-2">
          <p className="mb-3 rounded-2xl border border-warning bg-warning-container px-3 py-2 text-xs text-warning-on-container">
            <Trans
              i18nKey="admin.backup.create.warn"
              components={{ b: <strong /> }}
            />
          </p>
          <Button type="submit" variant="filled" size="sm" disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("admin.backup.create.queueing")}
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                {t("admin.backup.create.submit")}
              </>
            )}
          </Button>
        </div>
      </form>
    </section>
  );
}


/* -------------------------------------------------------------------------- */
/*  Component picker — shared by create + restore cards                        */
/* -------------------------------------------------------------------------- */

function ComponentPicker({
  selected,
  onToggle,
}: {
  selected: Set<BackupComponent>;
  onToggle: (c: BackupComponent) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {BACKUP_COMPONENTS.map((c) => {
        const on = selected.has(c);
        return (
          <button
            key={c}
            type="button"
            onClick={() => onToggle(c)}
            className={cn(
              "flex items-start gap-3 rounded-2xl border px-3 py-3 text-left transition-colors",
              on
                ? "border-primary bg-primary/[0.08]"
                : "border-outline-soft bg-surface-2 hover:bg-surface",
            )}
            aria-pressed={on}
          >
            <span
              className={cn(
                "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                on ? "border-primary bg-primary text-primary-on" : "border-ink-mute",
              )}
              aria-hidden
            >
              {on && <CheckIcon />}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-ink">
                {t(`admin.backup.components.${c}.title`)}
              </span>
              <span className="block text-xs text-ink-mute">
                {t(`admin.backup.components.${c}.body`)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3 8.5 6.5 12 13 4.5" />
    </svg>
  );
}


/* -------------------------------------------------------------------------- */
/*  Restore from backup                                                        */
/* -------------------------------------------------------------------------- */

function BackupRestoreCard({ onSubmitted }: { onSubmitted: () => Promise<void> }) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  // Same default as backup: all four selected. The server intersects
  // with the actual manifest contents, so "unchecked" wins over
  // "present in backup" — what gets applied is the smaller of the
  // two sets.
  const [components, setComponents] = useState<Set<BackupComponent>>(
    () => new Set<BackupComponent>(BACKUP_COMPONENTS),
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  function toggle(c: BackupComponent) {
    setComponents((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  async function onRestore(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      toast.error(t("admin.backup.restore.fileRequired"));
      return;
    }
    if (!passphrase) {
      toast.error(t("admin.backup.restore.passphraseRequired"));
      return;
    }
    if (confirmText !== "RESTORE") {
      toast.error(t("admin.backup.restore.confirmRequired"));
      return;
    }
    if (components.size === 0) {
      toast.error(t("admin.backup.components.noneSelected"));
      return;
    }
    if (!confirm(t("admin.backup.restore.lastChance"))) return;

    setBusy(true);
    try {
      await api.backup.restore(file, passphrase, [...components]);
      toast.success(t("admin.backup.restore.enqueued"));
      setFile(null);
      setPassphrase("");
      setConfirmText("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      await onSubmitted();
    } catch (e) {
      toast.error(t("admin.backup.restore.failed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="surface p-6">
      <header className="mb-4 flex items-center gap-2">
        <Upload className="h-5 w-5 text-danger" />
        <h2 className="text-lg font-bold tracking-tight text-ink">
          {t("admin.backup.restore.title")}
        </h2>
      </header>
      <div className="mb-4 rounded-2xl border border-danger bg-danger-container px-3 py-3 text-sm text-danger-on-container">
        <div className="mb-1 flex items-center gap-2 font-semibold">
          <AlertTriangle className="h-4 w-4" />
          {t("admin.backup.restore.dangerTitle")}
        </div>
        <p className="text-xs leading-relaxed">{t("admin.backup.restore.dangerBody")}</p>
      </div>
      <form onSubmit={onRestore} className="space-y-3">
        <div>
          <Label htmlFor="bk-file" className="text-[10px] uppercase tracking-wider text-ink-mute">
            {t("admin.backup.restore.file")}
          </Label>
          <Input
            id="bk-file"
            ref={fileInputRef}
            type="file"
            accept=".enc,.tar,.bin,application/octet-stream"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            disabled={busy}
          />
        </div>
        <div>
          <Label htmlFor="bk-restore-passphrase" className="text-[10px] uppercase tracking-wider text-ink-mute">
            {t("admin.backup.restore.passphrase")}
          </Label>
          <Input
            id="bk-restore-passphrase"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="off"
            disabled={busy}
          />
        </div>
        <div>
          <Label htmlFor="bk-confirm-text" className="text-[10px] uppercase tracking-wider text-ink-mute">
            {t("admin.backup.restore.confirmField")}
          </Label>
          <Input
            id="bk-confirm-text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="RESTORE"
            disabled={busy}
            autoComplete="off"
            className="font-mono"
          />
        </div>
        <div>
          <p className="mb-2 text-[10px] uppercase tracking-wider text-ink-mute">
            {t("admin.backup.components.restoreLabel")}
          </p>
          <ComponentPicker selected={components} onToggle={toggle} />
          <p className="mt-2 text-[11px] text-ink-mute">
            {t("admin.backup.components.restoreHint")}
          </p>
        </div>
        <Button type="submit" variant="filled" size="sm" disabled={busy}>
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("admin.backup.restore.queueing")}
            </>
          ) : (
            <>
              <Upload className="h-4 w-4" />
              {t("admin.backup.restore.submit")}
            </>
          )}
        </Button>
      </form>
    </section>
  );
}


/* -------------------------------------------------------------------------- */
/*  Jobs history (the 20 most recent)                                          */
/* -------------------------------------------------------------------------- */

function BackupHistoryCard({
  jobs,
  loading,
  onChange,
}: {
  jobs: BackupJob[];
  loading: boolean;
  onChange: () => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <section className="surface p-6">
      <header className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold tracking-tight text-ink">
          {t("admin.backup.history.title")}
        </h2>
        <Button variant="ghost" size="sm" onClick={() => void onChange()}>
          <RefreshCw className="h-3.5 w-3.5" /> {t("admin.backup.history.refresh")}
        </Button>
      </header>
      {loading ? (
        <p className="text-sm italic text-ink-mute">{t("common.loading")}</p>
      ) : jobs.length === 0 ? (
        <p className="text-sm italic text-ink-mute">{t("admin.backup.history.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {jobs.map((job) => (
            <BackupJobRow key={job.id} job={job} onChange={onChange} />
          ))}
        </ul>
      )}
    </section>
  );
}


export function BackupJobRow({
  job,
  onChange,
}: {
  job: BackupJob;
  onChange: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const { filename, blob } = await api.backup.download(job.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t("admin.backup.history.downloaded"));
      await onChange();
    } catch (e) {
      toast.error(t("admin.backup.history.downloadFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!confirm(t("admin.backup.history.cancelConfirm"))) return;
    setBusy(true);
    try {
      await api.backup.cancel(job.id);
      toast.success(t("admin.backup.history.cancelRequested"));
      await onChange();
    } catch (e) {
      toast.error(t("admin.backup.history.cancelFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  const active = job.status === "pending" || job.status === "running";

  return (
    <li className="rounded-2xl border border-outline-soft bg-surface-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <StatusPill status={job.status} kind={job.kind} />
          <span className="text-xs text-ink-mute">
            {job.kind === "backup"
              ? t("admin.backup.history.backupBy", { user: job.created_by_username || "—" })
              : t("admin.backup.history.restoreBy", { user: job.created_by_username || "—" })}
          </span>
          <span className="text-xs text-ink-mute">·</span>
          <span className="font-mono text-xs text-ink-mute">{job.id.slice(0, 8)}</span>
        </div>
        <div className="flex items-center gap-2">
          {job.downloadable && (
            <Button variant="filled" size="sm" disabled={busy} onClick={download}>
              <Download className="h-3.5 w-3.5" /> {t("admin.backup.history.download")}
            </Button>
          )}
          {job.cancellable && (
            <Button variant="outlined" size="sm" disabled={busy} onClick={cancel}>
              <X className="h-3.5 w-3.5" /> {t("admin.backup.history.cancel")}
            </Button>
          )}
        </div>
      </div>
      {active && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-[11px] text-ink-mute">
            <span>{job.phase || "—"}</span>
            <span>{job.progress_pct}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface">
            <div
              className="h-full bg-primary transition-all duration-500"
              style={{ width: `${Math.max(2, job.progress_pct)}%` }}
            />
          </div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-mute">
        <span>{t("admin.backup.history.created")}: {formatDate(job.created_at)}</span>
        {job.completed_at && (
          <span>{t("admin.backup.history.completed")}: {formatDate(job.completed_at)}</span>
        )}
        {job.file_size != null && (
          <span>{t("admin.backup.history.size")}: {formatBytes(job.file_size)}</span>
        )}
        {job.expires_at && job.status === "ready" && (
          <span>{t("admin.backup.history.expires")}: {formatDate(job.expires_at)}</span>
        )}
      </div>
      {(job.components.length > 0 ||
        (job.kind === "restore" && job.result_summary?.applied_components)) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {(job.kind === "restore" && job.result_summary?.applied_components
            ? job.result_summary.applied_components
            : job.components
          ).map((c) => (
            <span
              key={c}
              className="rounded-full bg-surface px-2 py-0.5 text-[10px] uppercase tracking-wider text-ink-soft"
            >
              {t(`admin.backup.components.${c}.tag`, { defaultValue: c })}
            </span>
          ))}
        </div>
      )}
      {job.error_message && (
        <p className="mt-2 rounded-xl border border-danger bg-danger-container px-3 py-2 text-xs text-danger-on-container">
          {job.error_message}
        </p>
      )}
      {job.result_summary && job.kind === "restore" && job.status === "done" && (
        <div className="mt-2 rounded-xl bg-surface px-3 py-2 text-xs text-ink-soft">
          <span className="font-medium">{t("admin.backup.history.restoredFrom")}: </span>
          {job.result_summary.created_at ? formatDate(job.result_summary.created_at) : "—"}
          {job.result_summary.backend_version && (
            <> · <span className="font-mono">{job.result_summary.backend_version}</span></>
          )}
        </div>
      )}
    </li>
  );
}


function StatusPill({
  status,
  kind,
}: {
  status: BackupJob["status"];
  kind: BackupJob["kind"];
}) {
  const { t } = useTranslation();
  const label = t(`admin.backup.status.${status}`);
  if (status === "ready" || status === "done") {
    return (
      <Badge variant="outline" className="border-primary text-primary">
        <CheckCircle2 className="h-3 w-3" /> {label}
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className="border-danger text-danger">
        <XCircle className="h-3 w-3" /> {label}
      </Badge>
    );
  }
  if (status === "cancelled") {
    return (
      <Badge variant="outline" className="border-ink-mute text-ink-mute">
        <XCircle className="h-3 w-3" /> {label}
      </Badge>
    );
  }
  if (status === "downloaded") {
    return (
      <Badge variant="outline" className="text-ink-mute">
        <CheckCircle2 className="h-3 w-3" /> {label}
      </Badge>
    );
  }
  // pending / running
  return (
    <Badge variant="outline" className="border-primary text-primary">
      <Loader2 className={cn("h-3 w-3", status === "running" && "animate-spin")} />
      {label}
      <span className="ml-1 text-[10px] text-ink-mute">
        ({kind === "backup" ? t("admin.backup.history.kindBackup") : t("admin.backup.history.kindRestore")})
      </span>
    </Badge>
  );
}


function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  let v = n;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}
