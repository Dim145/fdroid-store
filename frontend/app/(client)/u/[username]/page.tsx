// Server wrapper for the public profile view.
//
// Static export needs a build-time placeholder for every dynamic segment.
// The real username is read from ``usePathname()`` in the client component.
import ProfileClient from "./client";

export function generateStaticParams() {
  return [{ username: "__dynamic" }];
}

export const dynamicParams = false;

export default function ProfilePage() {
  return <ProfileClient />;
}
