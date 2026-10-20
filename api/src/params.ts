import { badRequest } from "./errors.js";

/**
 * Parse a non-negative integer path param (campaign/milestone ids are uint256
 * on-chain but always small here; we keep them as JS numbers for the query and
 * reject anything non-numeric or negative).
 */
export function intParam(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) {
    throw badRequest(`${name} must be a non-negative integer`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw badRequest(`${name} out of range`);
  }
  return n;
}

/** ?limit= — positive integer, clamped to [1, max]. Default `dflt`. */
export function limitParam(raw: unknown, dflt: number, max: number): number {
  if (raw === undefined) return dflt;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw badRequest("limit must be a positive integer");
  }
  const n = Number(raw);
  if (n < 1) throw badRequest("limit must be >= 1");
  return Math.min(n, max);
}

/**
 * ?sort= against a whitelist. Accepts `field` or `-field` (descending).
 * Returns a safe `ORDER BY` fragment built only from whitelisted column names.
 */
export function sortParam(
  raw: unknown,
  allowed: Record<string, string>,
  dflt: string,
): string {
  if (raw === undefined) return dflt;
  if (typeof raw !== "string" || raw === "") {
    throw badRequest("sort must be a string");
  }
  const desc = raw.startsWith("-");
  const key = desc ? raw.slice(1) : raw;
  const col = allowed[key];
  if (!col) {
    throw badRequest(
      `unknown sort '${raw}'. allowed: ${Object.keys(allowed).join(", ")} (prefix '-' for desc)`,
    );
  }
  return `${col} ${desc ? "DESC" : "ASC"}`;
}

export function ethAddressParam(raw: string, name = "address"): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw badRequest(`${name} must be a valid 40-character hex Ethereum address`);
  }
  return raw.toLowerCase();
}

