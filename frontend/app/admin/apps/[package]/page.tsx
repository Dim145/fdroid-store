// Static-export shim that turns ``/admin/apps/<pkg>/`` into the
// canonical ``/admin/apps/?app=<pkg>`` deeplink. Until this existed,
// the bare ``/admin/apps/<pkg>/`` URL fell through to the SPA root and
// landed the user on the home page — so any shared admin link to a
// specific app's management drawer 404'd in practice.
//
// With ``output: "export"`` Next still needs at least one param at
// build time for every dynamic segment, so we emit a single
// ``__dynamic`` placeholder; nginx's ``try_files`` resolves every
// real package name to it, and the client component reads the live
// segment via ``usePathname`` once it mounts.
import AdminAppRedirect from "./client";

export function generateStaticParams() {
  return [{ package: "__dynamic" }];
}

export const dynamicParams = false;

export default function AdminAppDeeplinkPage() {
  return <AdminAppRedirect />;
}
