// HEISEI Design System Colors & Theme Tokens

export const HEISEI_COLORS = {
  primary: '#0C4B63',       // Deep Teal (ヘッダー、主要導線)
  secondary: '#1A2E4A',     // Navy (本文、見出し、アイコン)
  accent: '#FF2D6F',        // Neon Pink (投稿、選択、通知、主要CTA)
  surfaceWarm: '#FFF6E6',   // Soft Cream (温かいカード、お知らせ)
  bg: '#F2F4F7',            // Light Gray (画面背景)
  surface: '#FFFFFF',       // White (カード背景、入力欄)
  success: '#00A86B',       // Pixel Green
  error: '#E63946',         // Warning Red
} as const;

export const HEISEI_ALT_COLORS = {
  classicTeal: '#008080',
  cyberNavy: '#000080',
  neonMagenta: '#FF007F',
  retroSilver: '#E8ECEF',
} as const;

export type HeiseiColors = typeof HEISEI_COLORS;
