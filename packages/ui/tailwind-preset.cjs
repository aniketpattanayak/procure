/** Tailwind preset for Procure. Consumers add `presets: [require('@procure/ui/tailwind-preset')]`
 *  and include `../../packages/ui/src/**\/*.{ts,tsx}` in `content`. */
const c = name => `rgb(var(--c-${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: c('bg'),
        surface: c('surface'),
        subtle: c('subtle'),
        muted: c('muted'),
        border: c('border'),
        'border-strong': c('border-strong'),
        fg: { DEFAULT: c('fg'), muted: c('fg-muted'), subtle: c('fg-subtle') },
        accent: { DEFAULT: c('accent'), hover: c('accent-hover'), fg: c('accent-fg'), soft: c('accent-soft') },
        ring: c('ring'),
        success: { DEFAULT: c('success'), soft: c('success-soft') },
        warning: { DEFAULT: c('warning'), bar: c('warning-bar'), soft: c('warning-soft') },
        danger: { DEFAULT: c('danger'), soft: c('danger-soft') },
        neutral: { soft: c('neutral-soft') },
      },
      fontFamily: { sans: ['var(--font-sans)'] },
      fontSize: {
        xs: ['0.857rem', { lineHeight: '1.25rem' }],   // 12px
        sm: ['0.929rem', { lineHeight: '1.35rem' }],   // 13px
        base: ['1rem', { lineHeight: '1.43rem' }],     // 14px
        md: ['1.143rem', { lineHeight: '1.6rem' }],    // 16px
        lg: ['1.286rem', { lineHeight: '1.75rem' }],   // 18px
        xl: ['1.571rem', { lineHeight: '2rem' }],      // 22px
      },
      borderRadius: { sm: 'var(--radius-sm)', DEFAULT: 'var(--radius)', md: 'var(--radius)', lg: 'var(--radius-lg)' },
      boxShadow: { pop: 'var(--shadow-pop)' },
      spacing: { sidebar: 'var(--sidebar-w)', topbar: 'var(--topbar-h)', banner: 'var(--banner-h)' },
      keyframes: {
        pulse: { '50%': { opacity: '0.55' } },
        'slide-in-left': { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(0)' } },
        'slide-in-right': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'pop-in': { from: { opacity: '0', transform: 'translateY(4px) scale(0.98)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: {
        'slide-in-left': 'slide-in-left 180ms ease-out',
        'slide-in-right': 'slide-in-right 180ms ease-out',
        'fade-in': 'fade-in 150ms ease-out',
        'pop-in': 'pop-in 140ms ease-out',
      },
    },
  },
  plugins: [],
};
