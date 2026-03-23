import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // M3 Dark color system
        background: '#0e0e0e',
        foreground: '#ffffff',
        primary: {
          DEFAULT: '#8cacff',
          dim: '#719bff',
          container: '#769dff',
          fixed: '#769dff',
          'fixed-dim': '#5e8fff',
        },
        secondary: {
          DEFAULT: '#d5e3fc',
          dim: '#c7d5ed',
          container: '#3a485b',
          fixed: '#d5e3fc',
          'fixed-dim': '#c7d5ed',
        },
        tertiary: {
          DEFAULT: '#ffb7f9',
          dim: '#ef93ec',
          container: '#fea0fb',
          fixed: '#fea0fb',
          'fixed-dim': '#ef93ec',
        },
        error: {
          DEFAULT: '#ff716c',
          dim: '#d7383b',
          container: '#9f0519',
        },
        surface: {
          DEFAULT: '#0e0e0e',
          dim: '#0e0e0e',
          bright: '#2c2c2c',
          variant: '#262626',
          tint: '#8cacff',
          container: {
            DEFAULT: '#1a1a1a',
            low: '#131313',
            high: '#20201f',
            highest: '#262626',
            lowest: '#000000',
          },
        },
        outline: {
          DEFAULT: '#767575',
          variant: '#484847',
        },
        'on-surface': {
          DEFAULT: '#ffffff',
          variant: '#adaaaa',
        },
        'on-primary': {
          DEFAULT: '#002a6d',
          container: '#001f55',
        },
        'on-secondary': {
          DEFAULT: '#455367',
          container: '#c3d1e9',
        },
        'on-tertiary': {
          DEFAULT: '#722275',
          container: '#67176b',
        },
        'on-error': {
          DEFAULT: '#490006',
          container: '#ffa8a3',
        },
        'inverse-surface': '#fcf9f8',
        'inverse-on-surface': '#565555',
        'inverse-primary': '#1458ca',
      },
      fontFamily: {
        sans: ['Manrope', 'system-ui', 'sans-serif'],
        headline: ['Manrope', 'system-ui', 'sans-serif'],
        body: ['Manrope', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '1rem',
        lg: '2rem',
        xl: '3rem',
      },
    },
  },
  plugins: [],
};

export default config;
