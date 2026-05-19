"use client";

import { Trash2, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type AppCollaborator } from "@/lib/api";
import { toast } from "@/lib/toast-store";


/* Section embedded inside /my-apps/[id]. Owners + admins see the
 * "Add collaborator" form; non-owners only see the read-only list (and
 * a "Leave" button on their own row). */
export function CollaboratorsSection({
  appId,
  ownerId,
  currentUserId,
}: {
  appId: string;
  ownerId: string;
  currentUserId: string;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<AppCollaborator[]>([]);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const isOwner = currentUserId === ownerId;

  async function reload() {
    setLoading(true);
    try {
      setRows(await api.collaborators.list(appId));
    } catch (e) {
      toast.error(t("myApps.edit.collaborators.loadFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [appId]);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    setAdding(true);
    try {
      await api.collaborators.add(appId, { username: username.trim() });
      toast.success(t("myApps.edit.collaborators.added"));
      setUsername("");
      await reload();
    } catch (e) {
      toast.error(t("myApps.edit.collaborators.addFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setAdding(false);
    }
  }

  async function onRemove(row: AppCollaborator) {
    const isSelf = row.user_id === currentUserId;
    const message = isSelf
      ? t("myApps.edit.collaborators.leaveConfirm")
      : t("myApps.edit.collaborators.removeConfirm", { username: row.username });
    if (!confirm(message)) return;
    setBusy(row.id);
    try {
      await api.collaborators.remove(appId, row.id);
      toast.success(isSelf ? t("myApps.edit.collaborators.left") : t("myApps.edit.collaborators.removed"));
      await reload();
    } catch (e) {
      toast.error(t("myApps.edit.collaborators.removeFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-soft">{t("myApps.edit.collaborators.body")}</p>
      {loading ? (
        <p className="text-sm italic text-ink-mute">{t("common.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-outline px-4 py-6 text-center text-sm italic text-ink-mute">
          {t("myApps.edit.collaborators.empty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-outline-soft bg-surface px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink">{row.username}</div>
                <div className="truncate text-xs text-ink-mute">{row.full_name || row.email}</div>
              </div>
              {(isOwner || row.user_id === currentUserId) && (
                <Button
                  size="sm"
                  variant="outlined"
                  onClick={() => onRemove(row)}
                  disabled={busy === row.id}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {row.user_id === currentUserId
                    ? t("myApps.edit.collaborators.leave")
                    : t("myApps.edit.collaborators.remove")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {isOwner && (
        <form onSubmit={onAdd} className="grid gap-2 md:grid-cols-[1fr_auto]">
          <div className="space-y-1">
            <Label htmlFor="collab-username" className="text-xs font-medium text-ink-soft">
              {t("myApps.edit.collaborators.addLabel")}
            </Label>
            <Input
              id="collab-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t("myApps.edit.collaborators.addPlaceholder")}
            />
          </div>
          <div className="flex items-end">
            <Button type="submit" variant="filled" disabled={adding || !username.trim()}>
              <UserPlus className="h-4 w-4" /> {adding ? t("common.saving") : t("myApps.edit.collaborators.add")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
