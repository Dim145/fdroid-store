// Tailwind v4 ships its PostCSS integration in a dedicated package; the old
// ``tailwindcss`` plugin entry was removed in the 4.0 release. Autoprefixer
// is still recommended for the same reasons as on v3.
export default {
  plugins: {
    "@tailwindcss/postcss": {},
    autoprefixer: {},
  },
};
