import { extname } from "node:path";
import { Router } from "express";
import multer from "multer";
import axios, { isAxiosError } from "axios";
import FormData from "form-data";
import { fileTypeFromBuffer } from "file-type";
import { config, ALLOWED_PROOF_FILE_TYPES } from "../config.js";
import { badRequest, ApiError, wrap } from "../errors.js";

export const proofs = Router();

const PIN_FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";

const ALLOWED_TYPES_SUMMARY = ALLOWED_PROOF_FILE_TYPES.map(
  (t) => `${t.label} (${t.extensions.join(", ")})`,
).join(", ");

function isAllowedMime(mime: string): boolean {
  return ALLOWED_PROOF_FILE_TYPES.some((t) =>
    (t.mimeTypes as readonly string[]).includes(mime),
  );
}

/**
 * multer fileFilter — FAST, FIRST PASS ONLY: requires the extension AND the
 * declared Content-Type to both match the SAME entry in
 * ALLOWED_PROOF_FILE_TYPES (config.ts). This is cheap (runs off multipart
 * headers, before any bytes are read) and rejects obviously-wrong requests
 * early, but it is NOT authoritative: both signals are client-declared, so a
 * client that simply doesn't override the MIME type for a renamed file (most
 * don't) sails through looking entirely consistent. The real gate is the
 * magic-byte check below, run on the actual buffered bytes once multer has
 * them. Rejecting via the callback's error (rather than `cb(null, false)`)
 * surfaces a specific ApiError/400 instead of leaving `req.file` silently
 * undefined.
 */
function proofFileFilter(
  _req: unknown,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile?: boolean) => void,
): void {
  const ext = extname(file.originalname || "").toLowerCase();
  const match = ALLOWED_PROOF_FILE_TYPES.find((t) =>
    (t.extensions as readonly string[]).includes(ext),
  );
  if (!match) {
    cb(
      badRequest(
        `unsupported file extension '${ext || "(none)"}'. allowed types: ${ALLOWED_TYPES_SUMMARY}`,
      ),
    );
    return;
  }
  if (!(match.mimeTypes as readonly string[]).includes(file.mimetype)) {
    cb(
      badRequest(
        `MIME type '${file.mimetype}' does not match a ${match.label} (extension '${ext}'). allowed types: ${ALLOWED_TYPES_SUMMARY}`,
      ),
    );
    return;
  }
  cb(null, true);
}

// Memory storage: the file never touches disk, just forwarded to Pinata as bytes.
// config.maxUploadBytes is 10MB by default (api/.env MAX_UPLOAD_BYTES) — the
// oversized/wrong-field/disallowed-type cases are all turned into 400s (see
// errors.ts's MulterError check, and proofFileFilter's ApiError above).
const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: proofFileFilter,
});

/**
 * POST /proofs/upload   (multipart/form-data, field name: "file")
 *
 * Pins a milestone proof file to IPFS via Pinata (axios + form-data) and
 * returns { cid, gatewayUrl }. This does NOT touch the chain or the `proofs`
 * table — that write only happens once someone submits the returned cid
 * on-chain via ProofRegistry.submitProof(...) and the indexer picks it up.
 *
 * On-chain boundary — deliberate, not an oversight: this route does the
 * off-chain storage step ONLY. There is no ethers.js/provider/signer anywhere
 * in this file (or in config.ts/errors.ts) and there must never be one here —
 * the API holds no private key. Submitting ProofRegistry.submitProof(cid) is
 * the verifier's own wallet transaction (frontend + MetaMask), signed
 * client-side with the cid this endpoint hands back. If you're looking for
 * where the CID becomes an on-chain fact, it's not in this process at all —
 * it's the frontend tx, then indexer/handlers.ts's ProofSubmitted handler.
 */
proofs.post(
  "/upload",
  (req, res, next) => {
    if (!config.pinataJwt) {
      next(new ApiError(503, "upload disabled: PINATA_JWT not configured on the server"));
      return;
    }
    next();
  },
  fileUpload.single("file"),
  wrap(async (req, res) => {
    const file = req.file;
    if (!file) {
      throw badRequest("missing file: send multipart/form-data with a 'file' field");
    }
    if (file.size === 0) throw badRequest("file is empty");

    // Authoritative second pass: sniff the actual bytes' magic number, ignoring
    // whatever the client claimed. This is what actually closes the gap the
    // fileFilter above can't — a renamed file with no spoofed MIME type passes
    // the header check but fails here because its real signature doesn't match.
    const detected = await fileTypeFromBuffer(file.buffer);
    if (!detected || !isAllowedMime(detected.mime)) {
      throw badRequest(
        `file content does not match an allowed type (detected: ${detected?.mime ?? "unrecognized binary data"}, ` +
          `declared: ${file.mimetype}). allowed types: ${ALLOWED_TYPES_SUMMARY}`,
      );
    }

    const form = new FormData();
    form.append("file", file.buffer, { filename: file.originalname || "proof" });
    form.append(
      "pinataMetadata",
      JSON.stringify({ name: file.originalname || "proof" }),
    );

    try {
      const { data } = await axios.post<{ IpfsHash: string }>(PIN_FILE_URL, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${config.pinataJwt}`,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      const cid = data.IpfsHash;
      const gatewayUrl = `https://${config.pinataGateway}/ipfs/${cid}`;
      res.status(201).json({ cid, gatewayUrl });
    } catch (err) {
      // Log Pinata's actual response body — its error messages are specific
      // (bad JWT, plan limit, etc.) and worth seeing server-side.
      if (isAxiosError(err)) {
        console.error(
          "[proofs/upload] Pinata request failed:",
          err.response?.status,
          err.response?.data ?? err.message,
        );
      } else {
        console.error("[proofs/upload] unexpected error:", err);
      }
      throw new ApiError(500, "failed to upload file to Pinata");
    }
  }),
);
