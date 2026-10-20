import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { pool } from "./db.js";
import { errorHandler } from "./errors.js";
import { campaigns } from "./routes/campaigns.js";
import { verifiers } from "./routes/verifiers.js";
import { milestones } from "./routes/milestones.js";
import { proofs } from "./routes/proofs.js";
import { stats } from "./routes/stats.js";

export function buildApp(): express.Express {
  const app = express();

  app.use(cors({ origin: config.corsOrigin }));
  // application/json only; multipart is handled by multer inside the proofs router.
  app.use(express.json({ limit: "1mb" }));
  app.disable("x-powered-by");

  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true, deployment: { chainId: config.chainId.toString(), escrow: config.escrowAddress } });
    } catch {
      res.status(503).json({ ok: false, error: "database unavailable" });
    }
  });

  app.use("/campaigns", campaigns);
  app.use("/verifiers", verifiers);
  app.use("/milestones", milestones);
  app.use("/proofs", proofs);
  app.use("/stats", stats);

  // unknown route
  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  app.use(errorHandler);
  return app;
}
