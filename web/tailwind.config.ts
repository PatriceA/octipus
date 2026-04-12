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
        // ── "Intelligent Void" palette (shared with landing + docs) ──
        background: '#0e0e0e',
        foreground: '#ffffff',

        primary: {
          DEFAULT: '#73ffe3',
          dim: '#00e8c9',
          container: '#00f5d4',
          fixed: '#12f8d7',
          'fixed-dim': '#00e8c9',
        },
        secondary: {
          DEFAULT: '#e5e2e1',
          dim: '#d7d4d3',
          container: '#474646',
          fixed: '#e5e2e1',
          'fixed-dim': '#d7d4d3',
        },
        tertiary: {
          DEFAULT: '#9cf3ff',
          dim: '#33ddef',
          container: '#4aebfd',
          fixed: '#4aebfd',
          'fixed-dim': '#33ddef',
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
          tint: '#73ffe3',
          container: {
            DEFAULT: '#1a1919',
            low: '#131313',
            high: '#201f1f',
            highest: '#262626',
            lowest: '#000000',
          },
        },
        outline: {
          DEFAULT: '#777575',
          variant: '#494847',
        },
        'on-surface': {
          DEFAULT: '#ffffff',
          variant: '#adaaaa',
        },
        'on-primary': {
          DEFAULT: '#006152',
          container: '#00574a',
          fixed: '#00443a',
          'fixed-variant': '#006455',
        },
        'on-secondary': {
          DEFAULT: '#525151',
          container: '#d3d0cf',
          fixed: '#403f3f',
          'fixed-variant': '#5c5b5b',
        },
        'on-tertiary': {
          DEFAULT: '#005d65',
          container: '#00535b',
          fixed: '#003f45',
          'fixed-variant': '#005e66',
        },
        'on-error': {
          DEFAULT: '#490006',
          container: '#ffa8a3',
        },
        'inverse-surface': '#fcf8f8',
        'inverse-on-surface': '#565554',
        'inverse-primary': '#006c5c',
      },
      fontFamily: {
        sans:     ['Inter', 'system-ui', 'sans-serif'],
        body:     ['Inter', 'system-ui', 'sans-serif'],
        headline: ['Manrope', 'system-ui', 'sans-serif'],
        display:  ['Manrope', 'system-ui', 'sans-serif'],
        label:    ['Inter', 'system-ui', 'sans-serif'],
        mono:     ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '0.5rem',
        lg: '1rem',
        xl: '1.5rem',
        full: '9999px',
      },
      backdropBlur: {
        glass: '20px',
      },
    },
  },
  plugins: [],
};

export default config;
