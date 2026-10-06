"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

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
  /** Admin master switch for the Reproducible Builds verification
   *  feature. Defaults true so the badge keeps showing until the very
   *  first /setup/status answers — flipping it off then makes the badge
   *  and per-APK editor disappear on the next render. */
  reproducibleBuildsEnabled: boolean;
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
  reproducibleBuildsEnabled: true,

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
          // Missing field on older backends → treat as enabled.
          reproducibleBuildsEnabled: s.reproducible_builds_enabled !== false,
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
        reproducibleBuildsEnabled: s.reproducible_builds_enabled !== false,
        loaded: true,
      });
    } catch {/* keep previous state */}
  },
}));

/** Read-side hook. Triggers the (deduplicated) one-time fetch on first
 *  mount; subsequent renders are pulled from the cache.
 *
 *  Uses ``useShallow`` so consumers only re-render when one of the
 *  primitives they actually read changes — selecting the whole store
 *  object (as we did before) re-rendered every dependent component on
 *  any mutation, even mutations they didn't care about. */
export function useRepoInfo() {
  const state = useRepoStore(
    useShallow((s) => ({
      url: s.url,
      fingerprint: s.fingerprint,
      name: s.name,
      description: s.description,
      iconPath: s.iconPath,
      loaded: s.loaded,
      setupComplete: s.setupComplete,
      publicMode: s.publicMode,
      reproducibleBuildsEnabled: s.reproducibleBuildsEnabled,
      fetchOnce: s.fetchOnce,
      refresh: s.refresh,
    })),
  );
  useEffect(() => {
    if (!state.loaded) state.fetchOnce();
  }, [state.loaded, state.fetchOnce]);
  return state;
}

/* ------------------------------------------------------------------ */
/* Deep-link helpers                                                   */
/* ------------------------------------------------------------------ */

/** True for a plain-HTTP repo URL. F-Droid 2.0 no longer opens
 *  ``fdroidrepo://`` links and F-Droid Basic 2.0 refuses cleartext
 *  traffic altogether (only the full flavour still allows it). */
export function isPlainHttp(url: string): boolean {
  return /^http:\/\//i.test(url);
}

/** True when the URL's authority carries an explicit port. */
function hasExplicitPort(hostAndPath: string): boolean {
  return /^[^/]*:\d+(\/|$)/.test(hostAndPath);
}

/** The username half of Basic-auth credentials is ignored server-side; it
 *  must still be URL-safe because the client splits userinfo naively on
 *  ``@`` and ``:``. */
function safeUsername(username: string): string {
  return /^[A-Za-z0-9._~-]+$/.test(username) ? username : "fdroid";
}

/* Build an F-Droid "add repository" link.
 *
 * What F-Droid 2.0 accepts: ``fdroidrepos://…`` and ``https://fdroid.link/#…``
 * (``fdroidrepo://`` and bare ``…/fdroid/repo`` URLs were dropped from its
 * manifest).
 *
 *   - public HTTPS:  fdroidrepos://host/fdroid/repo?fingerprint=…
 *   - public HTTP:   https://fdroid.link/#http://host/fdroid/repo?fingerprint=…
 *                    (still opens the app; only the full flavour can then
 *                    reach a cleartext repo)
 *   - private, no explicit port:
 *                    fdroidrepos://user:<key>@host/fdroid/repo?fingerprint=…
 *     The client strips the userinfo into the repo's Basic-auth credentials
 *     and keeps the canonical address, so every request is authenticated.
 *   - private with an explicit port:
 *                    fdroidrepo(s)://host:port/r/<key>/fdroid/repo?fingerprint=…
 *     ``RepoUriGetter`` rebuilds the host with ``Uri.Builder.authority()``,
 *     which percent-encodes ``host:port`` into ``host%3Aport`` whenever
 *     userinfo is present — so the key travels as a path segment instead
 *     (the backend's ``/r/{token}/…`` routes). Caveat: the client stores
 *     that URL as a *mirror* of the canonical (public) address and fetches
 *     the index from the canonical address first, so this form is only
 *     reliable on a private-mode repo.
 *
 * Credentials are never sent through fdroid.link: it's a third-party page.
 */
export function fdroidDeepLink(
  url: string,
  options?: { credentials?: { username: string; secret: string } | null; fingerprint?: string | null },
): string {
  const https = !isPlainHttp(url);
  const trimmed = url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  const fp = options?.fingerprint ? `?fingerprint=${options.fingerprint}` : "";
  const secret = options?.credentials?.secret;

  if (secret) {
    if (https && !hasExplicitPort(trimmed)) {
      const user = safeUsername(options?.credentials?.username || "");
      return `fdroidrepos://${user}:${encodeURIComponent(secret)}@${trimmed}${fp}`;
    }
    const withoutFDroid = trimmed.replace(/\/fdroid\/repo$/, "");
    const scheme = https ? "fdroidrepos" : "fdroidrepo";
    return `${scheme}://${withoutFDroid}/r/${encodeURIComponent(secret)}/fdroid/repo${fp}`;
  }
  if (https) return `fdroidrepos://${trimmed}${fp}`;
  return `https://fdroid.link/#http://${trimmed}${fp}`;
}
