import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { buildApp } from "../src/server.js";
import { pool } from "../src/db.js";
import { resolveDeployment } from "../src/deployment.js";

describe("Charity API Integration Tests", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    await resolveDeployment();
    const app = buildApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  test("GET /health returns 200 and deployment info", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.deployment);
    assert.equal(data.deployment.chainId, "31337");
  });

  test("GET /stats returns platform metrics", async () => {
    const res = await fetch(`${baseUrl}/stats`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(typeof data.campaignCount, "number");
    assert.equal(typeof data.totalBalance, "string");
    assert.equal(typeof data.totalReserved, "string");
    assert.equal(typeof data.activeVerifiers, "number");
  });

  test("GET /campaigns returns campaign array and pagination", async () => {
    const res = await fetch(`${baseUrl}/campaigns?limit=10`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.campaigns));
    assert.equal(typeof data.count, "number");
    assert.equal(data.limit, 10);
  });

  test("GET /verifiers/leaderboard returns leaderboard list", async () => {
    const res = await fetch(`${baseUrl}/verifiers/leaderboard`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.leaderboard));
  });

  test("GET /verifiers/:address returns verifier profile", async () => {
    const testAddr = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
    const res = await fetch(`${baseUrl}/verifiers/${testAddr}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.address, testAddr);
    assert.equal(typeof data.isVerifier, "boolean");
    assert.equal(typeof data.reputation, "number");
    assert.ok(Array.isArray(data.votes));
  });

  test("GET /verifiers/:address rejects invalid address", async () => {
    const res = await fetch(`${baseUrl}/verifiers/not-an-address`);
    assert.equal(res.status, 400);
  });

  test("GET /unknown-route returns 404", async () => {
    const res = await fetch(`${baseUrl}/some-nonexistent-route`);
    assert.equal(res.status, 404);
  });
});
