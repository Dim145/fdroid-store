"use client";

import { useEffect } from "react";
import { create } from "zustand";

import { api, REPO_URL } from "@/lib/api";

/* ============================================================================
 * Live repo info store.
 *
 * The frontend used to read NEXT_PUBLIC_REPO_URL as a build-time constant.
 * Problem: admins can change the public address at runtime via /admin/repo,
 * and the constant doesn't update — QR codes, install links and download
 * URLs ended up pointing to a stale host.
 *
 * This store hydrates from the public /setup/status endpoint (already
 * anonymous) and gives every consumer the live value. Components call
 * useRepoInfo() and get { url, fingerprint, name, description } with the
 * env URL as a safe fallback until the API answers.
 * ============================================================================ */

type RepoInfoState = {
  url: string;
  fingerprint: string | null;
  name: string | null;
  description: string | null;
  iconPath: string | null;
  /** True once /setup/status has been consumed (success or failure). */
  loaded: boolean;
  /** True if the API said setup_complete. */
  setupComplete: boolean;
  /** When false, anonymous visitors must be redirected to /login. */
  publicMode: boolean;
  fetchOnce: () => Promise<void>;
  /** Force re-fetch — used after the admin saves /admin/repo. */
  refresh: () => Promise<void>;
};

let inflight: Promise<void> | null = null;

export const useRepoStore = create<RepoInfoState>((set, get) => ({
  url: REPO_URL,
  fingerprint: null,
  name: null,
  description: null,
  iconPath: null,
  loaded: false,
  setupComplete: false,
  publicMode: true,

  async fetchOnce() {
    if (get().loaded) return;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const s = await api.setup.status();
        set({
          url: s.repo_address || REPO_URL,
          fingerprint: s.repo_fingerprint,
          name: s.repo_name,
          description: s.repo_description,
          iconPath: s.repo_icon_path,
          setupComplete: s.setup_complete,
          publicMode: s.public_mode,
          loaded: true,
        });
      } catch {
        set({ loaded: true });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },

  async refresh() {
    try {
      const s = await api.setup.status();
      set({
        url: s.repo_address || REPO_URL,
        fingerprint: s.repo_fingerprint,
        name: s.repo_name,
        description: s.repo_description,
        iconPath: s.repo_icon_path,
        setupComplete: s.setup_complete,
        publicMode: s.public_mode,
        loaded: true,
      });
    } catch {/* keep previous state */}
  },
}));

/** Read-side hook. Triggers the (deduplicated) one-time fetch on first
 *  mount; subsequent renders are pulled from the cache. */
export function useRepoInfo() {
  const state = useRepoStore();
  useEffect(() => {
    if (!state.loaded) state.fetchOnce();
  }, [state.loaded, state.fetchOnce]);
  return state;
}

/* ------------------------------------------------------------------ */
/* Deep-link helpers                                                   */
/* ------------------------------------------------------------------ */

/** Build the right F-Droid deep-link scheme for a given http(s) repo URL.
 *  `fdroidrepos://` opens HTTPS, `fdroidrepo://` opens HTTP — using the
 *  wrong one makes the F-Droid client connect on a port it can't reach. */
export function fdroidScheme(url: string): "fdroidrepos" | "fdroidrepo" {
  return url.startsWith("https://") ? "fdroidrepos" : "fdroidrepo";
}

/* Build an F-Droid deep-link URL.
 *
 * IMPORTANT — auth strategy:
 *
 *   - WITHOUT credentials: standard public repo URL. Public apps only.
 *   - WITH credentials: we do NOT embed `user:pass@` in the URL. The F-Droid
 *     Android client has a parser bug in `RepoUriGetter` (libs/database/.../
 *     RepoUriGetter.kt) where Android's `Uri.Builder.authority(value)` URL-
 *     encodes the rebuilt host, turning `host:port` into `host%3Aport` for
 *     any URL that combines userinfo *and* a port. Instead, we encode the
 *     API key as a URL *path segment* (/r/{token}/fdroid/repo/...) and the
 *     backend resolves it via a dedicated route. F-Droid sees a normal URL
 *     and never re-encodes anything.
 *
 * Net result the F-Droid client gets:
 *   - public:  fdroidrepo(s)://host/fdroid/repo?fingerprint=...
 *   - private: fdroidrepo(s)://host/r/<TOKEN>/fdroid/repo?fingerprint=...
 */
export function fdroidDeepLink(
  url: string,
  options?: { credentials?: { username: string; secret: string } | null; fingerprint?: string | null },
): string {
  const scheme = fdroidScheme(url);
  const trimmed = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const fp = options?.fingerprint ? `?fingerprint=${options.fingerprint}` : "";

  if (options?.credentials?.secret) {
    // The token *is* the secret (the public-facing "full key" from the
    // create-key flow). We replace the /fdroid/repo path with /r/<token>/
    // fdroid/repo, which the backend `/r/{token}/...` router resolves
    // back to the same content but with the credential applied.
    const withoutFDroid = trimmed.replace(/\/fdroid\/repo$/, "");
    return `${scheme}://${withoutFDroid}/r/${encodeURIComponent(options.credentials.secret)}/fdroid/repo${fp}`;
  }
  return `${scheme}://${trimmed}${fp}`;
}
