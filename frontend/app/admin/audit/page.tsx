"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type AuditLogEntry } from "@/lib/api";
import { toast } from "@/lib/toast-store";
import { formatDate } from "@/lib/utils";


const PAGE_SIZE = 50;


export default function AdminAuditPage() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState("");
  const [page, setPage] = useState(0);

  async function reload() {
    setLoading(true);
    try {
      const data = await api.admin.auditLog({
        action: actionFilter.trim() || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setRows(data.items);
      setTotal(data.total);
    } catch (e) {
      toast.error(t("admin.audit.loadFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [page]);

  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <div className="space-y-6">
      <header>
        <div className="eyebrow">{t("admin.eyebrow")}</div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">
          {t("admin.audit.title")}
        </h1>
        <p className="mt-1 text-ink-soft">{t("admin.audit.subtitle")}</p>
      </header>

      <section className="surface p-6">
        <form
          onSubmit={(e) => { e.preventDefault(); setPage(0); void reload(); }}
          className="mb-4 grid gap-2 md:grid-cols-[1fr_auto]"
        >
          <Input
            placeholder={t("admin.audit.filterPlaceholder")}
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
          />
          <Button type="submit" variant="filled">{t("common.search")}</Button>
        </form>

        {loading ? (
          <p className="text-sm italic text-ink-mute">{t("common.loading")}</p>
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-outline px-4 py-10 text-center italic text-ink-mute">
            {t("admin.audit.empty")}
          </p>
        ) : (
          <ul className="space-y-1">
            {rows.map((row) => (
              <li
                key={row.id}
                className="grid gap-2 rounded-xl border border-outline-soft bg-surface px-3 py-2 text-xs md:grid-cols-[160px_140px_140px_1fr]"
              >
                <span className="font-mono text-ink-mute">{formatDate(row.created_at)}</span>
                <span className="font-mono">{row.action}</span>
                <span className="truncate font-medium text-ink">
                  {row.actor_username || (row.actor_id ? row.actor_id.slice(0, 8) : t("admin.audit.system"))}
                </span>
                <span className="min-w-0 truncate text-ink-soft" title={row.summary || ""}>
                  {row.summary || "—"}
                  {row.target_type && (
                    <Badge variant="soft" className="ml-2 align-middle text-[10px]">
                      {row.target_type}
                    </Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {total > PAGE_SIZE && (
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs text-ink-mute">
              {t("admin.audit.pageOf", { page: page + 1, total: lastPage + 1, count: total })}
            </p>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outlined"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="outlined"
                onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
                disabled={page >= lastPage}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
