import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Geist_Mono, Fraunces } from "next/font/google";

import { I18nProvider } from "@/components/i18n-provider";
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

// ``--font-display`` powers the editorial-serif treatment on /stats —
// huge hero numerals, section titles set as if for print. Variable font
// covers weights 200–900 in a single woff2, so adding it costs ~60 KB
// only, and ``display: swap`` keeps it off the critical path.
const fontDisplay = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
  axes: ["opsz", "SOFT"],
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
      className={`${fontSans.variable} ${fontMono.variable} ${fontDisplay.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>
          <I18nProvider>{children}</I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
