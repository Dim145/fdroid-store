// Server wrapper for the client-only app detail view.
//
// With ``output: "export"`` Next.js needs at least one param at build time
// for every dynamic segment. App packages are user-generated content, so we
// emit a single placeholder route — nginx ``try_files`` falls back to it for
// any real ``/apps/<package>/`` URL, and the client component reads the real
// segment via ``useParams()`` once it mounts.
import AppDetailClient from "./client";

export function generateStaticParams() {
  return [{ package: "__dynamic" }];
}

export const dynamicParams = false;

export default function AppDetailPage() {
  return <AppDetailClient />;
}
