import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Geist_Mono } from "next/font/google";

import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const fontSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
});

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "fdroid-store — your private app shelf",
  description:
    "A self-hosted F-Droid repository with a modern app-store interface. Browse, install, and ship Android apps with full control.",
};

// Inline pre-paint script: reads localStorage / prefers-color-scheme and sets
// the `data-theme` attribute on <html> before React hydrates, so the page
// never flashes the wrong theme. Inlined as a string to bypass React's
// hydration mismatch detection on the html element.
const themeInitScript = `(function(){try{var s=localStorage.getItem("theme");var t=s||(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-theme="light"
      className={`${fontSans.variable} ${fontMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
