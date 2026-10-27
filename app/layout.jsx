import "@fontsource-variable/noto-sans-thai";
import "./globals.css";
import { Suspense } from "react";
import { AppShell } from "./components/app-shell";

export const metadata = {
  title: "Naina · Rental Operations",
  description: "ศูนย์จัดการลีด ห้องเช่า และการตอบกลับจาก Facebook",
};

export default function RootLayout({ children }) {
  return (
    <html lang="th" suppressHydrationWarning>
      <body>
        <Suspense fallback={<main>{children}</main>}><AppShell>{children}</AppShell></Suspense>
      </body>
    </html>
  );
}

