// Vitest runs server modules in Node without Next.js' `react-server` export
// condition. This empty target preserves the production `server-only` marker
// while allowing focused Node tests to import those modules.
export {};
