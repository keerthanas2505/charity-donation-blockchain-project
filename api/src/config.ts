import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load api/.env by absolute path so `npm start` works from any cwd. dotenv never
// overrides an already-set var, so a wrapper that pre-loads it is fine too.
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var ${name}`);
  return v;
}
function opt(name: string, dflt: string): string {
  return process.env[name] ?? dflt;
}
function num(name: string, dflt: number): number {
  const v = process.env[name];
  return v === undefined || v === "" ? dflt : Number(v);
}

const corsRaw = opt("CORS_ORIGIN", "*").trim();

export const config = {
  databaseUrl: req("DATABASE_URL"),

  // Identifies the deployment (4-contract set) this API serves. Resolved to a
  // numeric deployments.id at startup (see deployment.ts).
  chainId: BigInt(req("CHAIN_ID")),
  escrowAddress: req("ESCROW_ADDRESS").toLowerCase(),

  port: num("PORT", 4000),
  corsOrigin: corsRaw === "*" ? "*" : corsRaw.split(",").map((s) => s.trim()),

  // Pinata — server-side only. Empty JWT => /proofs/upload responds 503.
  pinataJwt: process.env.PINATA_JWT?.trim() || null,
  pinataGateway: opt("PINATA_GATEWAY", "gateway.pinata.cloud").trim(),
  maxUploadBytes: num("MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
} as const;

export type Config = typeof config;

/**
 * Allowed milestone-proof file types for POST /proofs/upload — the realistic
 * formats for a proof document (receipts, site photos, completion
 * certificates). A named constant here, not inline in the route, so the
 * allowlist is one place to find and extend.
 *
 * Each entry pairs its extensions with the exact MIME type(s) that must go
 * with them. The fileFilter in routes/proofs.ts requires a file's extension
 * AND its declared MIME type to match the SAME entry — checking only one
 * would be insufficient (a renamed file keeps a stale MIME type; a spoofed
 * MIME type keeps a permitted-looking extension).
 */
export const ALLOWED_PROOF_FILE_TYPES = [
  { label: "JPEG image", extensions: [".jpg", ".jpeg"], mimeTypes: ["image/jpeg"] },
  { label: "PNG image", extensions: [".png"], mimeTypes: ["image/png"] },
  { label: "PDF document", extensions: [".pdf"], mimeTypes: ["application/pdf"] },
] as const;
