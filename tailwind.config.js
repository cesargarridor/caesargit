const v = (n) => `rgb(var(--c-${n}) / <alpha-value>)`;
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        app: v("app"),
        panel: v("panel"),
        elev: v("elev"),
        line: v("line"),
        amber: { DEFAULT: v("accent"), hover: v("accent-hover"), soft: v("accent-soft") },
        onacc: v("on-accent"),
        scrim: v("scrim"),
        gray: { 50: v("gray-50"), 100: v("gray-100"), 200: v("gray-200"), 300: v("gray-300"), 400: v("gray-400"), 500: v("gray-500"), 600: v("gray-600") },
        sky: { 300: v("sky"), 400: v("sky") },
        emerald: { 300: v("emerald"), 500: v("git-added") },
        red: { 300: v("red") },
        git: {
          added: v("git-added"),
          modified: v("git-modified"),
          deleted: v("git-deleted"),
          renamed: v("git-renamed"),
          conflict: v("git-conflict"),
        },
      },
      boxShadow: {
        glow: "0 0 0 1px rgb(var(--c-accent) / .18), 0 0 14px rgb(var(--c-accent) / .22)",
        pop: "0 12px 40px -8px rgb(0 0 0 / .45)",
      },
      keyframes: {
        "fade-in": { from: { opacity: 0 }, to: { opacity: 1 } },
        "pop-in": { from: { opacity: 0, transform: "translateY(6px) scale(.97)" }, to: { opacity: 1, transform: "none" } },
        "slide-in": { from: { opacity: 0, transform: "translateX(24px)" }, to: { opacity: 1, transform: "none" } },
        shimmer: { "100%": { transform: "translateX(100%)" } },
        "glow-pulse": { "0%,100%": { opacity: 0.45 }, "50%": { opacity: 1 } },
        float: { "0%,100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-6px)" } },
      },
      animation: {
        "fade-in": "fade-in .15s ease-out",
        "pop-in": "pop-in .18s cubic-bezier(.2,.8,.2,1)",
        "slide-in": "slide-in .22s cubic-bezier(.2,.8,.2,1)",
        "glow-pulse": "glow-pulse 1.8s ease-in-out infinite",
        float: "float 4s ease-in-out infinite",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
