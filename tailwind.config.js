/** بناء Tailwind محلي — بديل عن CDN نسخة التطوير (cdn.tailwindcss.com).
 *  الإعداد = اتحاد الـconfigs المضمّنة يلي كانت منسوخة بكل صفحة (landing.html هو الأشمل).
 *  بعد أي تعديل: npm run build:css  (أو شغّلها بوضع --watch أثناء التطوير).
 */
const pluginForms = require("@tailwindcss/forms");
const pluginContainerQueries = require("@tailwindcss/container-queries");

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "./src/public/**/*.html",
    "./src/admin-pages/**/*.html",
    "./src/widget/**/*.js",
  ],
  theme: {
    extend: {
      colors: {
        "surface": "#fbf8ff", "background": "#fbf8ff", "surface-bright": "#fbf8ff",
        "surface-container-lowest": "#ffffff", "surface-container-low": "#f4f2fc",
        "surface-container": "#eeedf7", "surface-container-high": "#e8e7f1",
        "surface-container-highest": "#e3e1eb", "surface-variant": "#e3e1eb", "surface-dim": "#dad9e3",
        "on-surface": "#1a1b22", "on-surface-variant": "#444653", "on-background": "#1a1b22",
        "outline": "#757684", "outline-variant": "#c4c5d5",
        "primary": "#00288e", "on-primary": "#ffffff", "primary-container": "#1e40af",
        "on-primary-container": "#a8b8ff", "primary-fixed": "#dde1ff", "primary-fixed-dim": "#b8c4ff",
        "on-primary-fixed": "#001453", "on-primary-fixed-variant": "#173bab",
        "secondary": "#00687a", "on-secondary": "#ffffff", "secondary-container": "#57dffe",
        "on-secondary-container": "#006172", "secondary-fixed": "#acedff", "secondary-fixed-dim": "#4cd7f6",
        "tertiary": "#611e00", "on-tertiary": "#ffffff", "tertiary-container": "#872d00",
        "on-tertiary-container": "#ffa583",
        "error": "#ba1a1a", "on-error": "#ffffff", "error-container": "#ffdad6", "on-error-container": "#93000a",
        "inverse-surface": "#2f3037", "inverse-on-surface": "#f1f0fa", "inverse-primary": "#b8c4ff",
        "surface-tint": "#3755c3",
      },
      borderRadius: { DEFAULT: "0.25rem", lg: "0.5rem", xl: "0.75rem", full: "9999px" },
      spacing: { "margin-desktop": "32px", "gutter": "24px", "container-max": "1280px", "margin-mobile": "16px", "unit": "4px" },
      fontFamily: {
        "body-md": ["IBM Plex Sans Arabic"], "headline-lg": ["IBM Plex Sans Arabic"], "headline-md": ["IBM Plex Sans Arabic"],
        "headline-sm": ["IBM Plex Sans Arabic"], "display-lg": ["IBM Plex Sans Arabic"],
        "label-md": ["IBM Plex Sans Arabic"], "label-sm": ["IBM Plex Sans Arabic"], "body-lg": ["IBM Plex Sans Arabic"],
      },
      fontSize: {
        "body-md": ["16px", { lineHeight: "24px", fontWeight: "400" }],
        "headline-lg": ["32px", { lineHeight: "40px", fontWeight: "600" }],
        "headline-md": ["24px", { lineHeight: "32px", fontWeight: "600" }],
        "headline-sm": ["20px", { lineHeight: "28px", fontWeight: "600" }],
        "display-lg": ["48px", { lineHeight: "60px", fontWeight: "700" }],
        "label-md": ["14px", { lineHeight: "20px", fontWeight: "500" }],
        "label-sm": ["12px", { lineHeight: "16px", fontWeight: "500" }],
        "body-lg": ["18px", { lineHeight: "28px", fontWeight: "400" }],
      },
    },
  },
  plugins: [pluginForms, pluginContainerQueries],
};
