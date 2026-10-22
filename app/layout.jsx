import "@fontsource-variable/noto-sans-thai";
import "./globals.css";
import { AppShell } from "./components/app-shell";

export const metadata = {
  title: "Rental Radar · Rental Operations",
  description: "ศูนย์จัดการลีด ห้องเช่า และการตอบกลับจาก Facebook",
};

export default function RootLayout({ children }) {
  return (
    <html lang="th" suppressHydrationWarning>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

