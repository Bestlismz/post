import "./globals.css";

export const metadata = {
  title: "Reply Review POC",
  description: "Human-reviewed Facebook group reply prototype",
};

export default function RootLayout({ children }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}

