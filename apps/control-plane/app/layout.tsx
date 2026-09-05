import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Uptime402 · AI 자동 결제와 라우트 활성화 검증",
  description:
    "Gemini가 복구 옵션을 비교하고 정책 한도 안에서 Solana Devnet USDC로 자동 결제한 기록과 라우트 활성화 증거를 확인하세요.",
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
