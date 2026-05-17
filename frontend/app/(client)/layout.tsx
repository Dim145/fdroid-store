import { SiteHeader } from "@/components/site-header";

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="container flex-1 py-8">{children}</main>
    </div>
  );
}
