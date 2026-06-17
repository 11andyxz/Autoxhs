import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        xhs: {
          DEFAULT: "#FF2442",
          dark: "#E61E3C",
        },
      },
    },
  },
  plugins: [],
};

export default config;
