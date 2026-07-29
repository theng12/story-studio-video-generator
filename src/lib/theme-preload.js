// Apply the system theme before the page renders. Extension CSP permits this
// external script, unlike an inline <script> in the document head.
document.documentElement.setAttribute(
  'data-theme',
  matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
);
