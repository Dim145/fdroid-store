import { PrivateAccessGuard } from "@/components/private-access-guard";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Toaster } from "@/components/toaster";

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="container flex-1 py-6 md:py-10">
        <PrivateAccessGuard>{children}</PrivateAccessGuard>
      </main>
      <SiteFooter />
      <Toaster />
    </div>
  );
}
