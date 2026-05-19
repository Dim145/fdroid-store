"use client";

import { Check, Pencil, Plus, Tags, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type Category } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function AdminCategoriesPage() {
  const { t } = useTranslation();
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Create form
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);

  // Inline edit
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);

  async function refresh() {
    try {
      setCategories(await api.categories.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : t("admin.categories.loadFailed"));
    }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  async function createCategory(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setMsg(null); setCreating(true);
    try {
      await api.categories.create({
        name,
        description: description || null,
      });
      setName(""); setDescription("");
      setMsg(t("admin.categories.created"));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("admin.categories.createFailed"));
    } finally { setCreating(false); }
  }

  function startEdit(c: Category) {
    setEditingId(c.id);
    setEditName(c.name);
    setEditDescription(c.description || "");
    setMsg(null); setError(null);
  }
  function cancelEdit() {
    setEditingId(null);
    setEditName("");
    setEditDescription("");
  }
  async function saveEdit(c: Category) {
    setSavingId(c.id); setError(null); setMsg(null);
    try {
      await api.categories.update(c.id, {
        name: editName,
        description: editDescription || null,
      });
      setMsg(t("admin.categories.renamed", { name: editName }));
      cancelEdit();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("admin.categories.saveFailed"));
    } finally { setSavingId(null); }
  }

  async function deleteCategory(c: Category) {
    const count = c.app_count ?? 0;
    const warn =
      count > 0
        ? t("admin.categories.deleteConfirmWithApps", { name: c.name, count })
        : t("admin.categories.deleteConfirmEmpty", { name: c.name });
    if (!confirm(warn)) return;
    setError(null); setMsg(null); setSavingId(c.id);
    try {
      await api.categories.remove(c.id);
      setMsg(t("admin.categories.deleted", { name: c.name }));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("admin.categories.deleteFailed"));
    } finally { setSavingId(null); }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">{t("admin.eyebrow")}</div>
          <h1 className="mt-1 flex items-center gap-3 text-3xl font-bold tracking-tight text-ink md:text-4xl">
            <Tags className="h-7 w-7 text-primary" strokeWidth={2.2} />
            {t("admin.categories.title")}
          </h1>
          <p className="mt-1 max-w-2xl text-ink-soft">
            {t("admin.categories.subtitle")}
          </p>
        </div>
        <div className="font-mono text-xs text-ink-mute">
          {t("admin.categories.totalCount", { count: categories.length })}
        </div>
      </header>

      {msg && <p className="rounded-xl border border-primary bg-primary-container px-3 py-2 text-sm text-primary-on-container">{msg}</p>}
      {error && <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{error}</p>}

      <section className="surface p-6">
        <h2 className="mb-4 text-lg font-bold tracking-tight text-ink">{t("admin.categories.addTitle")}</h2>
        <form onSubmit={createCategory} className="grid gap-3 md:grid-cols-[1fr_2fr_auto]">
          <Field label={t("admin.categories.addNameLabel")} htmlFor="cname">
            <Input id="cname" required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("admin.categories.addNamePlaceholder")} />
          </Field>
          <Field label={t("admin.categories.addDescriptionLabel")} htmlFor="cdesc">
            <Input id="cdesc" maxLength={255} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("admin.categories.addDescriptionPlaceholder")} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="filled" className="w-full" disabled={creating}>
              <Plus className="h-4 w-4" /> {creating ? t("admin.categories.adding") : t("admin.categories.addBtn")}
            </Button>
          </div>
        </form>
      </section>

      <section className="surface overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("admin.categories.columns.name")}</TableHead>
              <TableHead className="hidden md:table-cell">{t("admin.categories.columns.description")}</TableHead>
              <TableHead className="w-28">{t("admin.categories.columns.usage")}</TableHead>
              <TableHead className="w-48 text-right">{t("admin.categories.columns.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {categories.map((c) => {
              const editing = editingId === c.id;
              const count = c.app_count ?? 0;
              return (
                <TableRow key={c.id} className={cn(editing && "bg-surface-2")}>
                  <TableCell>
                    {editing ? (
                      <Input
                        autoFocus
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-9"
                      />
                    ) : (
                      <span className="font-semibold text-ink">{c.name}</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {editing ? (
                      <Input
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        placeholder="—"
                        className="h-9"
                      />
                    ) : (
                      <span className="text-sm text-ink-soft">
                        {c.description || <span className="italic text-ink-mute">—</span>}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={count > 0 ? "primary" : "outline"}
                      className="font-mono"
                    >
                      {t("admin.categories.usageCount", { count })}
                    </Badge>
                  </TableCell>
                  <TableCell className="space-x-1 text-right">
                    {editing ? (
                      <>
                        <Button
                          size="sm"
                          variant="filled"
                          onClick={() => saveEdit(c)}
                          disabled={savingId === c.id || !editName.trim()}
                        >
                          <Check className="h-3.5 w-3.5" />
                          {t("admin.categories.save")}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={cancelEdit}>
                          <X className="h-3.5 w-3.5" />
                          {t("admin.categories.cancel")}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" variant="outlined" onClick={() => startEdit(c)}>
                          <Pencil className="h-3.5 w-3.5" />
                          {t("admin.categories.edit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => deleteCategory(c)}
                          disabled={savingId === c.id}
                          className="text-danger hover:bg-danger-container hover:text-danger-on-container"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {t("admin.categories.delete")}
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {categories.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center italic text-ink-mute">
                  {t("admin.categories.empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-sm font-medium text-ink-soft">{label}</Label>
      {children}
    </div>
  );
}
