/**
 * Vitest setup — runs before any test module (hence before config.ts is
 * imported and reads the env). Pins a known write token so the guard/round-trip
 * tests authenticate, without depending on whatever DASHBOARD_WRITE_TOKEN the
 * developer's .env happens to hold.
 */
process.env.DASHBOARD_WRITE_TOKEN = "test-write-token-do-not-ship";
