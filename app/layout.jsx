import "./globals.css";

export const metadata = {
  title: "Rental Radar · Lead Command Center",
  description: "Facebook rental lead monitoring and Messenger operations",
};

export default function RootLayout({ children }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}

