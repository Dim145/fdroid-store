// Server wrapper for the client-only "manage app" view. Same reasoning as
// ``apps/[package]/page.tsx``: the dynamic segment is filled at runtime, but
// static export still needs at least one buildable param. nginx serves the
// placeholder file for any real ID; the client reads ``useParams()``.
import ManageAppClient from "./client";

export function generateStaticParams() {
  return [{ id: "__dynamic" }];
}

export const dynamicParams = false;

export default function ManageAppPage() {
  return <ManageAppClient />;
}
