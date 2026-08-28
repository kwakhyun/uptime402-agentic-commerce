import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Uptime402 · AI가 자동 결제해 복구하는 서비스",
  description:
    "Gemini AI SRE가 복구 옵션을 비교하고 정책 한도 안에서 Solana USDC로 자동 결제한 뒤 서비스 상태를 복구합니다.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f6f7f9",
  colorScheme: "light",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
