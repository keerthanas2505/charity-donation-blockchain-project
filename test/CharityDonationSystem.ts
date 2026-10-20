import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();
const { loadFixture, time } = networkHelpers;

// ─────────────────────────────────────────────────────────────────────────────
// Constants / encoders
// ─────────────────────────────────────────────────────────────────────────────

const MIN_STAKE = ethers.parseEther("1");
const TIMELOCK = 48 * 60 * 60; // CampaignEscrow.TIMELOCK
const VOTING_PERIOD = 3 * 24 * 60 * 60; // MilestoneVoting.VOTING_PERIOD

const State = {
  Pending: 0n,
  Timelocked: 1n,
  Released: 2n,
  Disputed: 3n,
  Rejected: 4n,
};
const RoundStatus = { None: 0n, Open: 1n, Finalized: 2n };

const coder = ethers.AbiCoder.defaultAbiCoder();
const encodePairs = (cids: number[], mids: number[]) =>
  coder.encode(["uint256[]", "uint256[]"], [cids, mids]);
const encodeWindow = (start: number, count: number) =>
  coder.encode(["uint256", "uint256"], [start, count]);
const decodePairs = (data: string) => {
  const [c, m] = coder.decode(["uint256[]", "uint256[]"], data);
  return { cids: [...c].map(Number), mids: [...m].map(Number) };
};

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

// Escrow alone, with a signer standing in for MilestoneVoting and another for
// VerifierRegistry, so state transitions can be driven directly.
async function escrowStandaloneFixture() {
  const [deployer, mockMV, mockReg, beneficiary, donor, outsider] =
    await ethers.getSigners();
  const escrow = await ethers.deployContract("CampaignEscrow");
  await escrow.setMilestoneVoting(mockMV.address);
  await escrow.setVerifierRegistry(mockReg.address);
  return { escrow, deployer, mockMV, mockReg, beneficiary, donor, outsider };
}

// Registry wired to a real escrow (so slash routing works) with a signer
// standing in for MilestoneVoting, plus one campaign in escrow as the slash sink.
async function registryFixture() {
  const [deployer, mockMV, D, E, benef, outsider] = await ethers.getSigners();
  const escrow = await ethers.deployContract("CampaignEscrow");
  const registry = await ethers.deployContract("VerifierRegistry", [
    MIN_STAKE,
    await escrow.getAddress(),
  ]);
  await escrow.setVerifierRegistry(await registry.getAddress());
  await registry.setMilestoneVoting(mockMV.address);
  await escrow
    .connect(deployer)
    .createCampaign(benef.address, ["m0"], [ethers.parseEther("0.01")]);
  return { escrow, registry, deployer, mockMV, D, E, benef, outsider };
}

// Escrow + ProofRegistry, MV mocked by a signer; campaign 0 has 2 milestones,
// funded.
async function proofRegistryFixture() {
  const [deployer, mockMV, beneficiary, outsider] = await ethers.getSigners();
  const escrow = await ethers.deployContract("CampaignEscrow");
  await escrow.setMilestoneVoting(mockMV.address);
  await escrow.setVerifierRegistry(deployer.address); // unused here
  const proofs = await ethers.deployContract("ProofRegistry", [
    await escrow.getAddress(),
  ]);
  await escrow
    .connect(deployer)
    .createCampaign(
      beneficiary.address,
      ["m0", "m1"],
      [ethers.parseEther("0.01"), ethers.parseEther("0.01")],
    );
  await escrow
    .connect(deployer)
    .donate(0, { value: ethers.parseEther("1") });
  return { escrow, proofs, deployer, mockMV, beneficiary, outsider };
}

// All four contracts, fully wired.
async function fullSystemFixture() {
  const [deployer, beneficiary, v1, v2, v3, v4, v5, v6, outsider] =
    await ethers.getSigners();
  const escrow = await ethers.deployContract("CampaignEscrow");
  const registry = await ethers.deployContract("VerifierRegistry", [
    MIN_STAKE,
    await escrow.getAddress(),
  ]);
  const proofs = await ethers.deployContract("ProofRegistry", [
    await escrow.getAddress(),
  ]);
  const voting = await ethers.deployContract("MilestoneVoting", [
    await registry.getAddress(),
    await proofs.getAddress(),
    await escrow.getAddress(),
  ]);
  await escrow.setVerifierRegistry(await registry.getAddress());
  await escrow.setMilestoneVoting(await voting.getAddress());
  await registry.setMilestoneVoting(await voting.getAddress());
  return {
    escrow,
    registry,
    proofs,
    voting,
    deployer,
    beneficiary,
    verifiers: [v1, v2, v3, v4, v5, v6],
    outsider,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function stakeAll(registry: any, who: any[], amount = MIN_STAKE) {
  for (const w of who) await registry.connect(w).stake({ value: amount });
}

async function newCampaign(
  escrow: any,
  from: any,
  beneficiary: string,
  amounts: bigint[],
) {
  await escrow
    .connect(from)
    .createCampaign(
      beneficiary,
      amounts.map((_, i) => `milestone ${i}`),
      amounts,
    );
  return (await escrow.campaignCount()) - 1n;
}

// full-system: submit a proof for (c, m) from the campaign beneficiary
async function submitProof(ctx: any, c: bigint | number, m: number, cid?: string) {
  await ctx.proofs
    .connect(ctx.beneficiary)
    .submitProof(c, m, cid ?? `cid-${c}-${m}`);
}

// full-system: open a round, cast the given approve/reject votes, finalize
async function runRound(
  ctx: any,
  c: bigint | number,
  m: number,
  approvers: any[],
  rejecters: any[] = [],
  { finalize = true, advancePastDeadline = false } = {},
) {
  await ctx.voting.openVotingRound(c, m);
  for (const v of approvers) await ctx.voting.connect(v).castVote(c, m, true);
  for (const v of rejecters) await ctx.voting.connect(v).castVote(c, m, false);
  if (advancePastDeadline) await time.increase(VOTING_PERIOD + 1);
  if (finalize) return ctx.voting.finalizeRound(c, m); // tx response, for .to.emit(...)
}

// ═════════════════════════════════════════════════════════════════════════════
// VerifierRegistry
// ═════════════════════════════════════════════════════════════════════════════

describe("VerifierRegistry", () => {
  describe("staking", () => {
    it("first stake >= minStake joins the pool and seeds reputation 100", async () => {
      const { registry, D } = await loadFixture(registryFixture);
      await expect(registry.connect(D).stake({ value: MIN_STAKE }))
        .to.emit(registry, "VerifierJoined")
        .withArgs(D.address)
        .and.to.emit(registry, "ReputationChanged")
        .withArgs(D.address, 0n, 100n);

      expect(await registry.isVerifier(D.address)).to.equal(true);
      expect(await registry.reputationOf(D.address)).to.equal(100n);
      expect(await registry.totalWeight()).to.equal(100n);
      expect(await registry.stakedAmount(D.address)).to.equal(MIN_STAKE);
    });

    it("reverts below minStake and on zero value", async () => {
      const { registry, D } = await loadFixture(registryFixture);
      await expect(
        registry.connect(D).stake({ value: MIN_STAKE - 1n }),
      ).to.be.revertedWith("below minStake");
      await expect(registry.connect(D).stake({ value: 0 })).to.be.revertedWith(
        "no ETH sent",
      );
    });

    it("top-up by an existing verifier adds stake without touching reputation", async () => {
      const { registry, D } = await loadFixture(registryFixture);
      await registry.connect(D).stake({ value: MIN_STAKE });
      await expect(
        registry.connect(D).stake({ value: ethers.parseEther("0.5") }),
      ).to.not.emit(registry, "VerifierJoined");
      expect(await registry.stakedAmount(D.address)).to.equal(
        MIN_STAKE + ethers.parseEther("0.5"),
      );
      expect(await registry.reputationOf(D.address)).to.equal(100n);
      expect(await registry.totalWeight()).to.equal(100n);
    });
  });

  describe("unstaking", () => {
    it("returns the full stake and clears verifier state", async () => {
      const { registry, D } = await loadFixture(registryFixture);
      await registry.connect(D).stake({ value: MIN_STAKE });

      await expect(registry.connect(D).unstake()).to.changeEtherBalance(
        ethers,
        D,
        MIN_STAKE,
      );
      expect(await registry.isVerifier(D.address)).to.equal(false);
      expect(await registry.reputationOf(D.address)).to.equal(0n);
      expect(await registry.stakedAmount(D.address)).to.equal(0n);
      expect(await registry.totalWeight()).to.equal(0n);
    });

    it("reverts when nothing is staked", async () => {
      const { registry, E } = await loadFixture(registryFixture);
      await expect(registry.connect(E).unstake()).to.be.revertedWith(
        "nothing staked",
      );
    });

    it("is blocked while the verifier has an unresolved vote, then allowed", async () => {
      const { registry, mockMV, D } = await loadFixture(registryFixture);
      await registry.connect(D).stake({ value: MIN_STAKE });

      await registry.connect(mockMV).incrementPendingVotes(D.address);
      await expect(registry.connect(D).unstake()).to.be.revertedWith(
        "pending votes",
      );

      await registry.connect(mockMV).decrementPendingVotes(D.address);
      await registry.connect(D).unstake();
      expect(await registry.stakedAmount(D.address)).to.equal(0n);
    });
  });

  describe("pending-vote hooks", () => {
    it("only MilestoneVoting may call them; decrement underflow is guarded", async () => {
      const { registry, mockMV, D, outsider } =
        await loadFixture(registryFixture);
      await expect(
        registry.connect(outsider).incrementPendingVotes(D.address),
      ).to.be.revertedWith("only MilestoneVoting");
      await expect(
        registry.connect(outsider).decrementPendingVotes(D.address),
      ).to.be.revertedWith("only MilestoneVoting");
      await expect(
        registry.connect(mockMV).decrementPendingVotes(D.address),
      ).to.be.revertedWith("no pending votes");
    });
  });

  describe("reputation clamping", () => {
    it("clamps to 200 on the way up", async () => {
      const { registry, mockMV, D } = await loadFixture(registryFixture);
      await registry.connect(D).stake({ value: MIN_STAKE });

      await registry.connect(mockMV).adjustReputation(D.address, 150); // 100 -> 200
      expect(await registry.reputationOf(D.address)).to.equal(200n);

      await registry.connect(mockMV).applyVoteResult(D.address, true, 0); // +5 -> stays 200
      expect(await registry.reputationOf(D.address)).to.equal(200n);
      expect(await registry.totalWeight()).to.equal(200n);
    });

    it("clamps to 0 on the way down", async () => {
      const { registry, mockMV, D } = await loadFixture(registryFixture);
      await registry.connect(D).stake({ value: MIN_STAKE });

      await registry.connect(mockMV).adjustReputation(D.address, -95); // 100 -> 5
      expect(await registry.reputationOf(D.address)).to.equal(5n);

      await registry.connect(mockMV).applyVoteResult(D.address, false, 0); // -10 -> 0, strike 1
      expect(await registry.reputationOf(D.address)).to.equal(0n);
      expect(await registry.againstStrikes(D.address)).to.equal(1n);
      expect(await registry.totalWeight()).to.equal(0n);
    });

    it("an aligned vote resets the strike counter (strikes must be consecutive)", async () => {
      const { registry, mockMV, D } = await loadFixture(registryFixture);
      await registry.connect(D).stake({ value: MIN_STAKE });

      await registry.connect(mockMV).applyVoteResult(D.address, false, 0);
      await registry.connect(mockMV).applyVoteResult(D.address, false, 0);
      expect(await registry.againstStrikes(D.address)).to.equal(2n);

      await registry.connect(mockMV).applyVoteResult(D.address, true, 0); // reset
      expect(await registry.againstStrikes(D.address)).to.equal(0n);

      // two more misses -> only strike 2, no slash
      await registry.connect(mockMV).applyVoteResult(D.address, false, 0);
      await registry.connect(mockMV).applyVoteResult(D.address, false, 0);
      expect(await registry.againstStrikes(D.address)).to.equal(2n);
      expect(await registry.stakedAmount(D.address)).to.equal(MIN_STAKE); // never slashed
    });
  });

  describe("slashing", () => {
    it("the 3rd consecutive against-consensus vote slashes 10% and routes it to the campaign", async () => {
      const { registry, escrow, mockMV, D } =
        await loadFixture(registryFixture);
      await registry.connect(D).stake({ value: MIN_STAKE });

      await registry.connect(mockMV).applyVoteResult(D.address, false, 0);
      expect(await registry.totalWeight()).to.equal(90n);
      await registry.connect(mockMV).applyVoteResult(D.address, false, 0);
      expect(await registry.totalWeight()).to.equal(80n);

      const slashAmount = MIN_STAKE / 10n; // 0.1 ETH
      await expect(registry.connect(mockMV).applyVoteResult(D.address, false, 0))
        .to.emit(registry, "Slashed")
        .withArgs(D.address, slashAmount)
        .and.to.emit(registry, "SlashRoutedToEscrow")
        .withArgs(D.address, 0n, slashAmount)
        .and.to.emit(escrow, "SlashedFundsReceived")
        .withArgs(0n, await registry.getAddress(), slashAmount);

      expect(await registry.reputationOf(D.address)).to.equal(0n);
      expect(await registry.isVerifier(D.address)).to.equal(false);
      expect(await registry.stakedAmount(D.address)).to.equal(
        MIN_STAKE - slashAmount,
      );
      expect(await registry.againstStrikes(D.address)).to.equal(0n);
      expect(await registry.totalWeight()).to.equal(0n);

      const [, , balance] = await escrow.getCampaign(0);
      expect(balance).to.equal(slashAmount); // slash credited to campaign 0
    });

    it("access control: only MilestoneVoting may call applyVoteResult / adjustReputation", async () => {
      const { registry, outsider, D } = await loadFixture(registryFixture);
      await expect(
        registry.connect(outsider).applyVoteResult(D.address, true, 0),
      ).to.be.revertedWith("only MilestoneVoting");
      await expect(
        registry.connect(outsider).adjustReputation(D.address, 1),
      ).to.be.revertedWith("only MilestoneVoting");
    });
  });

  describe("totalWeight bookkeeping", () => {
    it("normal unstake removes exactly that verifier's weight", async () => {
      const { registry, D, E } = await loadFixture(registryFixture);
      await stakeAll(registry, [D, E]);
      expect(await registry.totalWeight()).to.equal(200n);

      await registry.connect(D).unstake();
      expect(await registry.totalWeight()).to.equal(100n);
      expect(await registry.isVerifier(E.address)).to.equal(true);
    });

    it("slash-triggered drop removes the verifier's weight (intermediate + final)", async () => {
      const { registry, mockMV, D, E } = await loadFixture(registryFixture);
      await stakeAll(registry, [D, E]); // totalWeight 200

      await registry.connect(mockMV).applyVoteResult(D.address, false, 0);
      expect(await registry.totalWeight()).to.equal(190n); // 90 + 100
      await registry.connect(mockMV).applyVoteResult(D.address, false, 0);
      expect(await registry.totalWeight()).to.equal(180n); // 80 + 100
      await registry.connect(mockMV).applyVoteResult(D.address, false, 0); // slash + drop
      expect(await registry.totalWeight()).to.equal(100n); // only E
    });
  });

  describe("re-join after slash", () => {
    it("re-joins at fresh reputation 100; leftover stake counts toward minStake", async () => {
      const { registry, mockMV, D } = await loadFixture(registryFixture);
      await registry.connect(D).stake({ value: MIN_STAKE });
      for (let i = 0; i < 3; i++)
        await registry.connect(mockMV).applyVoteResult(D.address, false, 0);

      // slashed out: 0.9 ETH left, not a verifier
      expect(await registry.isVerifier(D.address)).to.equal(false);
      expect(await registry.stakedAmount(D.address)).to.equal(
        ethers.parseEther("0.9"),
      );

      // still short of minStake
      await expect(
        registry.connect(D).stake({ value: ethers.parseEther("0.05") }),
      ).to.be.revertedWith("below minStake");

      // top up to exactly minStake with the leftover counting
      await expect(
        registry.connect(D).stake({ value: ethers.parseEther("0.1") }),
      )
        .to.emit(registry, "VerifierJoined")
        .withArgs(D.address)
        .and.to.emit(registry, "ReputationChanged")
        .withArgs(D.address, 0n, 100n);

      expect(await registry.isVerifier(D.address)).to.equal(true);
      expect(await registry.reputationOf(D.address)).to.equal(100n); // fresh, not resumed
      expect(await registry.stakedAmount(D.address)).to.equal(MIN_STAKE);
      expect(await registry.totalWeight()).to.equal(100n);
      expect(await registry.againstStrikes(D.address)).to.equal(0n);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CampaignEscrow — state machine, funds, disputes, reentrancy
// ═════════════════════════════════════════════════════════════════════════════

describe("CampaignEscrow — state machine", () => {
  const ONE = ethers.parseEther("1");

  describe("createCampaign", () => {
    it("creates a campaign with Pending milestones", async () => {
      const { escrow, deployer, beneficiary } = await loadFixture(
        escrowStandaloneFixture,
      );
      await expect(
        escrow
          .connect(deployer)
          .createCampaign(beneficiary.address, ["well", "school"], [ONE, ONE]),
      )
        .to.emit(escrow, "CampaignCreated")
        .withArgs(0n, deployer.address, beneficiary.address, 2n);

      const [creator, benef, balance, reserved, mCount] =
        await escrow.getCampaign(0);
      expect(creator).to.equal(deployer.address);
      expect(benef).to.equal(beneficiary.address);
      expect(balance).to.equal(0n);
      expect(reserved).to.equal(0n);
      expect(mCount).to.equal(2n);

      const [desc, amount, st, releaseAfter] = await escrow.getMilestone(0, 0);
      expect(desc).to.equal("well");
      expect(amount).to.equal(ONE);
      expect(st).to.equal(State.Pending);
      expect(releaseAfter).to.equal(0n);
    });

    it("input validation", async () => {
      const { escrow, deployer, beneficiary } = await loadFixture(
        escrowStandaloneFixture,
      );
      const c = escrow.connect(deployer);
      await expect(
        c.createCampaign(ethers.ZeroAddress, ["m"], [ONE]),
      ).to.be.revertedWith("zero beneficiary");
      await expect(
        c.createCampaign(beneficiary.address, ["m", "n"], [ONE]),
      ).to.be.revertedWith("length mismatch");
      await expect(
        c.createCampaign(beneficiary.address, [], []),
      ).to.be.revertedWith("no milestones");
      await expect(
        c.createCampaign(beneficiary.address, ["m"], [0]),
      ).to.be.revertedWith("zero amount");
      const many = Array.from({ length: 51 }, (_, i) => `m${i}`);
      await expect(
        c.createCampaign(
          beneficiary.address,
          many,
          many.map(() => ONE),
        ),
      ).to.be.revertedWith("too many milestones");
    });
  });

  describe("donate", () => {
    it("adds to campaign balance; validates inputs", async () => {
      const { escrow, deployer, donor, beneficiary } = await loadFixture(
        escrowStandaloneFixture,
      );
      await newCampaign(escrow, deployer, beneficiary.address, [ONE]);

      await expect(escrow.connect(donor).donate(0, { value: ethers.parseEther("2") }))
        .to.emit(escrow, "Donated")
        .withArgs(0n, donor.address, ethers.parseEther("2"), ethers.parseEther("2"));
      expect(await escrow.availableBalance(0)).to.equal(ethers.parseEther("2"));

      await expect(escrow.connect(donor).donate(99, { value: 1 })).to.be.revertedWith(
        "no campaign",
      );
      await expect(escrow.connect(donor).donate(0, { value: 0 })).to.be.revertedWith(
        "no ETH sent",
      );
    });
  });

  describe("startTimelock", () => {
    it("only MilestoneVoting; requires Pending and sufficient funds", async () => {
      const { escrow, deployer, mockMV, outsider, beneficiary } =
        await loadFixture(escrowStandaloneFixture);
      await newCampaign(escrow, deployer, beneficiary.address, [ONE]);

      await expect(
        escrow.connect(outsider).startTimelock(0, 0),
      ).to.be.revertedWith("only MilestoneVoting");
      await expect(
        escrow.connect(mockMV).startTimelock(0, 0),
      ).to.be.revertedWith("campaign underfunded");

      await escrow.connect(deployer).donate(0, { value: ONE });
      const tx = await escrow.connect(mockMV).startTimelock(0, 0);
      await tx.wait();
      const now = await time.latest();

      const [, , st, releaseAfter] = await escrow.getMilestone(0, 0);
      expect(st).to.equal(State.Timelocked);
      expect(releaseAfter).to.equal(BigInt(now + TIMELOCK));
      const [, , , reserved] = await escrow.getCampaign(0);
      expect(reserved).to.equal(ONE);

      await expect(
        escrow.connect(mockMV).startTimelock(0, 0),
      ).to.be.revertedWith("milestone not pending");
    });
  });

  describe("raiseDispute", () => {
    it("only MilestoneVoting; only Timelocked and only inside the window", async () => {
      const { escrow, deployer, mockMV, outsider, beneficiary } =
        await loadFixture(escrowStandaloneFixture);
      await newCampaign(escrow, deployer, beneficiary.address, [ONE]);
      await escrow.connect(deployer).donate(0, { value: ONE });

      await expect(
        escrow.connect(mockMV).raiseDispute(0, 0),
      ).to.be.revertedWith("milestone not timelocked");

      await escrow.connect(mockMV).startTimelock(0, 0);
      await expect(escrow.connect(outsider).raiseDispute(0, 0)).to.be.revertedWith(
        "only MilestoneVoting",
      );

      await expect(escrow.connect(mockMV).raiseDispute(0, 0))
        .to.emit(escrow, "DisputeRaised")
        .withArgs(0n, 0n);
      const [, , st] = await escrow.getMilestone(0, 0);
      expect(st).to.equal(State.Disputed);
    });

    it("reverts once the timelock window has closed", async () => {
      const { escrow, deployer, mockMV, beneficiary } = await loadFixture(
        escrowStandaloneFixture,
      );
      await newCampaign(escrow, deployer, beneficiary.address, [ONE]);
      await escrow.connect(deployer).donate(0, { value: ONE });
      await escrow.connect(mockMV).startTimelock(0, 0);
      await time.increase(TIMELOCK + 10);
      await expect(escrow.connect(mockMV).raiseDispute(0, 0)).to.be.revertedWith(
        "timelock window closed",
      );
    });
  });

  describe("release — single revert message", () => {
    it('every not-releasable case reverts with "milestone not releasable"', async () => {
      const { escrow, deployer, mockMV, beneficiary } = await loadFixture(
        escrowStandaloneFixture,
      );
      await newCampaign(escrow, deployer, beneficiary.address, [ONE]);
      await escrow.connect(deployer).donate(0, { value: ONE });

      // Pending
      await expect(escrow.release(0, 0)).to.be.revertedWith(
        "milestone not releasable",
      );
      // out-of-range ids (NOT "no campaign" / "no milestone" any more)
      await expect(escrow.release(99, 0)).to.be.revertedWith(
        "milestone not releasable",
      );
      await expect(escrow.release(0, 99)).to.be.revertedWith(
        "milestone not releasable",
      );

      await escrow.connect(mockMV).startTimelock(0, 0);
      // Timelocked but window not elapsed
      await expect(escrow.release(0, 0)).to.be.revertedWith(
        "milestone not releasable",
      );

      // Disputed
      await escrow.connect(mockMV).raiseDispute(0, 0);
      await time.increase(TIMELOCK + 10);
      await expect(escrow.release(0, 0)).to.be.revertedWith(
        "milestone not releasable",
      );
    });

    it("releases to the beneficiary once Timelocked and elapsed; updates balances", async () => {
      const { escrow, deployer, mockMV, beneficiary, outsider } =
        await loadFixture(escrowStandaloneFixture);
      await newCampaign(escrow, deployer, beneficiary.address, [ONE]);
      await escrow.connect(deployer).donate(0, { value: ethers.parseEther("3") });
      await escrow.connect(mockMV).startTimelock(0, 0);
      await time.increase(TIMELOCK + 1);

      const before = await ethers.provider.getBalance(beneficiary.address);
      await expect(escrow.connect(outsider).release(0, 0))
        .to.emit(escrow, "MilestoneReleased")
        .withArgs(0n, 0n, beneficiary.address, ONE);
      expect(
        (await ethers.provider.getBalance(beneficiary.address)) - before,
      ).to.equal(ONE);

      const [, , st] = await escrow.getMilestone(0, 0);
      expect(st).to.equal(State.Released);
      const [, , balance, reserved] = await escrow.getCampaign(0);
      expect(balance).to.equal(ethers.parseEther("2"));
      expect(reserved).to.equal(0n);

      await expect(escrow.release(0, 0)).to.be.revertedWith(
        "milestone not releasable",
      );
    });

    it("a raised dispute halts release even after the original window elapses", async () => {
      const { escrow, deployer, mockMV, beneficiary } = await loadFixture(
        escrowStandaloneFixture,
      );
      await newCampaign(escrow, deployer, beneficiary.address, [ONE]);
      await escrow.connect(deployer).donate(0, { value: ONE });
      await escrow.connect(mockMV).startTimelock(0, 0);
      await escrow.connect(mockMV).raiseDispute(0, 0);
      await time.increase(TIMELOCK * 3);
      await expect(escrow.release(0, 0)).to.be.revertedWith(
        "milestone not releasable",
      );
    });
  });

  describe("resolveDispute", () => {
    async function disputed() {
      const ctx = await loadFixture(escrowStandaloneFixture);
      const { escrow, deployer, mockMV, beneficiary } = ctx;
      await newCampaign(escrow, deployer, beneficiary.address, [ONE]);
      await escrow.connect(deployer).donate(0, { value: ethers.parseEther("2") });
      await escrow.connect(mockMV).startTimelock(0, 0);
      await escrow.connect(mockMV).raiseDispute(0, 0);
      return ctx;
    }

    it("only the owner; only a Disputed milestone", async () => {
      const { escrow, deployer, mockMV, outsider, beneficiary } =
        await loadFixture(escrowStandaloneFixture);
      await newCampaign(escrow, deployer, beneficiary.address, [ONE]);
      await escrow.connect(deployer).donate(0, { value: ONE });
      await expect(
        escrow.connect(outsider).resolveDispute(0, 0, true),
      ).to.be.revertedWith("only owner");
      await expect(
        escrow.connect(deployer).resolveDispute(0, 0, true),
      ).to.be.revertedWith("milestone not disputed");
    });

    it("uphold=true pays the beneficiary and moves to Released", async () => {
      const { escrow, deployer, beneficiary } = await disputed();
      const before = await ethers.provider.getBalance(beneficiary.address);
      await expect(escrow.connect(deployer).resolveDispute(0, 0, true))
        .to.emit(escrow, "DisputeResolved")
        .withArgs(0n, 0n, true);
      expect(
        (await ethers.provider.getBalance(beneficiary.address)) - before,
      ).to.equal(ONE);
      const [, , st] = await escrow.getMilestone(0, 0);
      expect(st).to.equal(State.Released);
    });

    it("uphold=false rejects the milestone, frees its reserve, pays nobody", async () => {
      const { escrow, deployer, beneficiary } = await disputed();
      const before = await ethers.provider.getBalance(beneficiary.address);
      await expect(escrow.connect(deployer).resolveDispute(0, 0, false))
        .to.emit(escrow, "DisputeResolved")
        .withArgs(0n, 0n, false);
      expect(
        (await ethers.provider.getBalance(beneficiary.address)) - before,
      ).to.equal(0n);
      const [, , st, releaseAfter] = await escrow.getMilestone(0, 0);
      expect(st).to.equal(State.Rejected);
      expect(releaseAfter).to.equal(0n);
      const [, , balance, reserved] = await escrow.getCampaign(0);
      expect(balance).to.equal(ethers.parseEther("2")); // untouched
      expect(reserved).to.equal(0n); // freed
    });
  });

  describe("creditSlashed access control", () => {
    it("only the wired VerifierRegistry; routes to campaign or to unallocated", async () => {
      const { escrow, mockReg, outsider, deployer, beneficiary } =
        await loadFixture(escrowStandaloneFixture);
      await newCampaign(escrow, deployer, beneficiary.address, [ONE]);

      await expect(
        escrow.connect(outsider).creditSlashed(0, { value: ethers.parseEther("0.1") }),
      ).to.be.revertedWith("only VerifierRegistry");

      await escrow
        .connect(mockReg)
        .creditSlashed(0, { value: ethers.parseEther("0.1") });
      const [, , balance] = await escrow.getCampaign(0);
      expect(balance).to.equal(ethers.parseEther("0.1"));

      await escrow
        .connect(mockReg)
        .creditSlashed(42, { value: ethers.parseEther("0.2") }); // no such campaign
      expect(await escrow.unallocatedSlashed()).to.equal(ethers.parseEther("0.2"));
    });

    it("sweepUnallocated is owner-only and needs something to sweep", async () => {
      const { escrow, mockReg, deployer, outsider } = await loadFixture(
        escrowStandaloneFixture,
      );
      await expect(
        escrow.connect(deployer).sweepUnallocated(deployer.address),
      ).to.be.revertedWith("nothing to sweep");
      await escrow
        .connect(mockReg)
        .creditSlashed(7, { value: ethers.parseEther("0.3") });
      await expect(
        escrow.connect(outsider).sweepUnallocated(outsider.address),
      ).to.be.revertedWith("only owner");
      await expect(
        escrow.connect(deployer).sweepUnallocated(deployer.address),
      ).to.changeEtherBalance(ethers, deployer, ethers.parseEther("0.3"));
      expect(await escrow.unallocatedSlashed()).to.equal(0n);
    });
  });

  describe("availableBalance", () => {
    it("tracks balance - reserved across the lifecycle", async () => {
      const { escrow, deployer, mockMV, beneficiary } = await loadFixture(
        escrowStandaloneFixture,
      );
      const TWO = ethers.parseEther("2");
      await newCampaign(escrow, deployer, beneficiary.address, [TWO, TWO]);
      await expect(escrow.availableBalance(99)).to.be.revertedWith("no campaign");

      await escrow.connect(deployer).donate(0, { value: ethers.parseEther("5") });
      expect(await escrow.availableBalance(0)).to.equal(ethers.parseEther("5"));

      await escrow.connect(mockMV).startTimelock(0, 0); // reserve 2
      expect(await escrow.availableBalance(0)).to.equal(ethers.parseEther("3"));
      await escrow.connect(mockMV).startTimelock(0, 1); // reserve 2 more
      expect(await escrow.availableBalance(0)).to.equal(ethers.parseEther("1"));

      await escrow.connect(mockMV).raiseDispute(0, 0);
      await escrow.connect(deployer).resolveDispute(0, 0, false); // free milestone 0's 2
      expect(await escrow.availableBalance(0)).to.equal(ethers.parseEther("3"));

      await time.increase(TIMELOCK + 1);
      await escrow.release(0, 1); // balance-2 and reserved-2 -> available unchanged
      expect(await escrow.availableBalance(0)).to.equal(ethers.parseEther("3"));
    });
  });

  describe("reentrancy on release()/_payout()", () => {
    it("re-entry into release() reverts with the guard message; exactly one payout occurs", async () => {
      const { escrow, deployer, mockMV, outsider } = await loadFixture(
        escrowStandaloneFixture,
      );
      const attacker = await ethers.deployContract("ReentrantBeneficiary", [
        await escrow.getAddress(),
      ]);
      const attackerAddr = await attacker.getAddress();

      await newCampaign(escrow, deployer, attackerAddr, [ONE]);
      await escrow.connect(deployer).donate(0, { value: ONE });
      await escrow.connect(mockMV).startTimelock(0, 0);
      await time.increase(TIMELOCK + 1);
      await attacker.arm(0, 0);

      const before = await ethers.provider.getBalance(attackerAddr);
      await escrow.connect(outsider).release(0, 0);
      const after = await ethers.provider.getBalance(attackerAddr);

      expect(await attacker.reentered()).to.equal(true);
      expect(await attacker.reentryReverted()).to.equal(true);
      expect(await attacker.reentryRevertReason()).to.equal("reentrant call");
      expect(after - before).to.equal(ONE); // single payout, no double-spend
      const [, , st] = await escrow.getMilestone(0, 0);
      expect(st).to.equal(State.Released);
      await expect(escrow.release(0, 0)).to.be.revertedWith(
        "milestone not releasable",
      );
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CampaignEscrow — Chainlink Automation extension
// ═════════════════════════════════════════════════════════════════════════════

describe("CampaignEscrow — automation", () => {
  const SMALL = ethers.parseEther("0.01");

  // create one campaign of `n` milestones, fund it, timelock every milestone
  async function readyCampaign(ctx: any, n: number) {
    const { escrow, deployer, mockMV, beneficiary } = ctx;
    const c = await newCampaign(
      escrow,
      deployer,
      beneficiary.address,
      Array.from({ length: n }, () => SMALL),
    );
    await escrow.connect(deployer).donate(c, { value: SMALL * BigInt(n) });
    for (let i = 0; i < n; i++) await escrow.connect(mockMV).startTimelock(c, i);
    return c;
  }

  it("checkUpkeep returns (false, 0x) when nothing is timelocked/elapsed", async () => {
    const ctx = await loadFixture(escrowStandaloneFixture);
    let [needed, data] = await ctx.escrow.checkUpkeep("0x");
    expect(needed).to.equal(false);
    expect(data).to.equal("0x");

    await readyCampaign(ctx, 1); // timelocked but window not elapsed
    [needed, data] = await ctx.escrow.checkUpkeep("0x");
    expect(needed).to.equal(false);
  });

  it("checkUpkeep reports ready milestones once the window elapses; performUpkeep releases them", async () => {
    const ctx = await loadFixture(escrowStandaloneFixture);
    const c = await readyCampaign(ctx, 1);
    await time.increase(TIMELOCK + 1);

    const [needed, data] = await ctx.escrow.checkUpkeep("0x");
    expect(needed).to.equal(true);
    expect(decodePairs(data)).to.deep.equal({
      cids: [Number(c)],
      mids: [0],
    });

    const before = await ethers.provider.getBalance(ctx.beneficiary.address);
    await expect(ctx.escrow.connect(ctx.outsider).performUpkeep(data))
      .to.emit(ctx.escrow, "UpkeepPerformed")
      .withArgs(ctx.outsider.address, 1n);
    expect(
      (await ethers.provider.getBalance(ctx.beneficiary.address)) - before,
    ).to.equal(SMALL);
    const [, , st] = await ctx.escrow.getMilestone(c, 0);
    expect(st).to.equal(State.Released);
  });

  it("checkUpkeep caps its result at MAX_UPKEEP_BATCH (20)", async () => {
    const ctx = await loadFixture(escrowStandaloneFixture);
    const c = await readyCampaign(ctx, 22);
    await time.increase(TIMELOCK + 1000);

    const [needed, data] = await ctx.escrow.checkUpkeep("0x");
    expect(needed).to.equal(true);
    const { cids, mids } = decodePairs(data);
    expect(cids.length).to.equal(20);
    expect(mids).to.deep.equal([...Array(20).keys()]); // first 20 in scan order

    await ctx.escrow.performUpkeep(data);
    const [again, data2] = await ctx.escrow.checkUpkeep("0x");
    expect(again).to.equal(true);
    expect(decodePairs(data2).mids).to.deep.equal([20, 21]); // remaining 2
    await ctx.escrow.performUpkeep(data2);
    const [done] = await ctx.escrow.checkUpkeep("0x");
    expect(done).to.equal(false);
  });

  it("performUpkeep processes at most MAX_UPKEEP_BATCH entries from its own performData", async () => {
    const ctx = await loadFixture(escrowStandaloneFixture);
    const c = await readyCampaign(ctx, 22);
    await time.increase(TIMELOCK + 1000);

    const many = encodePairs(
      Array(22).fill(Number(c)),
      [...Array(22).keys()],
    );
    await expect(ctx.escrow.performUpkeep(many))
      .to.emit(ctx.escrow, "UpkeepPerformed")
      .withArgs(ctx.deployer.address, 20n);

    const [, , st19] = await ctx.escrow.getMilestone(c, 19);
    const [, , st20] = await ctx.escrow.getMilestone(c, 20);
    expect(st19).to.equal(State.Released);
    expect(st20).to.equal(State.Timelocked); // beyond the cap, untouched
  });

  it("performUpkeep skips stale / already-released entries without reverting", async () => {
    const ctx = await loadFixture(escrowStandaloneFixture);
    const c = await readyCampaign(ctx, 3);
    await time.increase(TIMELOCK + 1);

    await ctx.escrow.release(c, 1); // release milestone 1 manually first

    const data = encodePairs([Number(c), Number(c), Number(c)], [0, 1, 2]);
    await expect(ctx.escrow.performUpkeep(data))
      .to.emit(ctx.escrow, "UpkeepPerformed")
      .withArgs(ctx.deployer.address, 2n); // 0 and 2, milestone 1 skipped

    for (const i of [0, 1, 2]) {
      const [, , st] = await ctx.escrow.getMilestone(c, i);
      expect(st).to.equal(State.Released);
    }
  });

  it('performUpkeep reverts "no milestones released" when nothing in performData is ready', async () => {
    const ctx = await loadFixture(escrowStandaloneFixture);
    const c = await readyCampaign(ctx, 2);
    await time.increase(TIMELOCK + 1);
    await ctx.escrow.performUpkeep(encodePairs([Number(c), Number(c)], [0, 1]));

    // everything already released
    await expect(
      ctx.escrow.performUpkeep(encodePairs([Number(c), Number(c)], [0, 1])),
    ).to.be.revertedWith("no milestones released");
    // entirely out-of-range ids
    await expect(
      ctx.escrow.performUpkeep(encodePairs([99], [99])),
    ).to.be.revertedWith("no milestones released");
  });

  it('performUpkeep reverts "length mismatch" on unequal arrays', async () => {
    const ctx = await loadFixture(escrowStandaloneFixture);
    await expect(
      ctx.escrow.performUpkeep(encodePairs([0, 1], [0])),
    ).to.be.revertedWith("length mismatch");
  });

  it("checkUpkeep honours the (start, count) window and clamps count to MAX_CAMPAIGN_SCAN", async () => {
    const ctx = await loadFixture(escrowStandaloneFixture);
    // three separate campaigns, one ready milestone each
    for (let k = 0; k < 3; k++) await readyCampaign(ctx, 1);
    await time.increase(TIMELOCK + 1);

    expect(decodePairs((await ctx.escrow.checkUpkeep("0x"))[1]).cids).to.deep.equal([
      0, 1, 2,
    ]);
    expect(
      decodePairs((await ctx.escrow.checkUpkeep(encodeWindow(1, 1)))[1]).cids,
    ).to.deep.equal([1]);
    expect(
      decodePairs((await ctx.escrow.checkUpkeep(encodeWindow(0, 2)))[1]).cids,
    ).to.deep.equal([0, 1]);
    expect(
      decodePairs((await ctx.escrow.checkUpkeep(encodeWindow(2, 100)))[1]).cids,
    ).to.deep.equal([2]);
    // count 999 is clamped to MAX_CAMPAIGN_SCAN (100); with 3 campaigns it just
    // scans all of them and does not revert.
    const [needed, data] = await ctx.escrow.checkUpkeep(encodeWindow(0, 999));
    expect(needed).to.equal(true);
    expect(decodePairs(data).cids).to.deep.equal([0, 1, 2]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MilestoneVoting
// ═════════════════════════════════════════════════════════════════════════════

describe("MilestoneVoting", () => {
  const SMALL = ethers.parseEther("0.01");

  describe("openVotingRound gating", () => {
    it("blocks until a proof exists, then allows the round (proof gates voting)", async () => {
      const ctx = await loadFixture(fullSystemFixture);
      await stakeAll(ctx.registry, [ctx.verifiers[0]]);
      const c = await newCampaign(ctx.escrow, ctx.deployer, ctx.beneficiary.address, [
        SMALL,
      ]);
      await ctx.escrow.connect(ctx.deployer).donate(c, { value: SMALL });

      await expect(ctx.voting.openVotingRound(c, 0)).to.be.revertedWith(
        "no proof submitted",
      );
      await submitProof(ctx, c, 0);
      await expect(ctx.voting.openVotingRound(c, 0)).to.emit(ctx.voting, "RoundOpened");
      expect(await ctx.voting.currentRoundIndex(c, 0)).to.equal(1n);
    });

    it('enforces the underfunded pre-check (availableBalance >= milestone amount)', async () => {
      const ctx = await loadFixture(fullSystemFixture);
      await stakeAll(ctx.registry, [ctx.verifiers[0]]);
      const c = await newCampaign(ctx.escrow, ctx.deployer, ctx.beneficiary.address, [
        ethers.parseEther("1"),
      ]);
      await submitProof(ctx, c, 0);

      await expect(ctx.voting.openVotingRound(c, 0)).to.be.revertedWith(
        "campaign underfunded",
      );
      await ctx.escrow.connect(ctx.deployer).donate(c, { value: ethers.parseEther("0.5") });
      await expect(ctx.voting.openVotingRound(c, 0)).to.be.revertedWith(
        "campaign underfunded",
      );
      await ctx.escrow.connect(ctx.deployer).donate(c, { value: ethers.parseEther("0.5") });
      await ctx.voting.openVotingRound(c, 0);
      expect(await ctx.voting.currentRoundIndex(c, 0)).to.equal(1n);
    });

    it("requires a Pending milestone and non-zero verifier weight", async () => {
      const ctx = await loadFixture(fullSystemFixture);
      const c = await newCampaign(ctx.escrow, ctx.deployer, ctx.beneficiary.address, [
        SMALL,
      ]);
      await ctx.escrow.connect(ctx.deployer).donate(c, { value: SMALL });
      await submitProof(ctx, c, 0);

      await expect(ctx.voting.openVotingRound(c, 0)).to.be.revertedWith(
        "no verifier weight",
      );
      await stakeAll(ctx.registry, [ctx.verifiers[0]]);
      await ctx.voting.openVotingRound(c, 0);
      await ctx.voting.connect(ctx.verifiers[0]).castVote(c, 0, true);
      await ctx.voting.finalizeRound(c, 0); // milestone -> Timelocked
      await expect(ctx.voting.openVotingRound(c, 0)).to.be.revertedWith(
        "milestone not pending",
      );
    });
  });

  describe("weighted vote tallying", () => {
    it("approve/reject weight equals each voter's current reputation, not a headcount", async () => {
      const ctx = await loadFixture(fullSystemFixture);
      const [v1, v2, v3] = ctx.verifiers;
      await stakeAll(ctx.registry, [v1, v2, v3]); // all rep 100, totalWeight 300
      const c = await newCampaign(ctx.escrow, ctx.deployer, ctx.beneficiary.address, [
        SMALL,
        SMALL,
      ]);
      await ctx.escrow.connect(ctx.deployer).donate(c, { value: ethers.parseEther("1") });
      await submitProof(ctx, c, 0);
      await submitProof(ctx, c, 1);

      // warm-up round on milestone 0: v1, v2 approve -> both +5 -> rep 105
      await runRound(ctx, c, 0, [v1, v2]);
      expect(await ctx.registry.reputationOf(v1.address)).to.equal(105n);
      expect(await ctx.registry.reputationOf(v3.address)).to.equal(100n);

      // milestone 1: v3 (100) approves, v1 (105) rejects
      await ctx.voting.openVotingRound(c, 1);
      await ctx.voting.connect(v3).castVote(c, 1, true);
      await ctx.voting.connect(v1).castVote(c, 1, false);
      const r = await ctx.voting.getRound(c, 1);
      expect(r.approveWeight).to.equal(100n); // exactly v3's reputation
      expect(r.rejectWeight).to.equal(105n); // exactly v1's reputation
      expect(r.voterCount).to.equal(2n);
    });

    it("rejects non-verifiers and double votes", async () => {
      const ctx = await loadFixture(fullSystemFixture);
      const [v1] = ctx.verifiers;
      await stakeAll(ctx.registry, [v1]);
      const c = await newCampaign(ctx.escrow, ctx.deployer, ctx.beneficiary.address, [
        SMALL,
      ]);
      await ctx.escrow.connect(ctx.deployer).donate(c, { value: SMALL });
      await submitProof(ctx, c, 0);
      await ctx.voting.openVotingRound(c, 0);

      await expect(
        ctx.voting.connect(ctx.outsider).castVote(c, 0, true),
      ).to.be.revertedWith("not a verifier");
      await ctx.voting.connect(v1).castVote(c, 0, true);
      await expect(ctx.voting.connect(v1).castVote(c, 0, true)).to.be.revertedWith(
        "already voted",
      );
    });
  });

  describe("66% approval threshold — path independence (early vs deadline finalize)", () => {
    it("same votes give the same `approved` whether finalized early or at the deadline", async () => {
      const ctx = await loadFixture(fullSystemFixture);
      const [v1, v2, v3] = ctx.verifiers;
      await stakeAll(ctx.registry, [v1, v2, v3]); // totalWeight 300; threshold 198
      const c = await newCampaign(ctx.escrow, ctx.deployer, ctx.beneficiary.address, [
        SMALL,
        SMALL,
        SMALL,
      ]);
      await ctx.escrow.connect(ctx.deployer).donate(c, { value: ethers.parseEther("1") });
      for (const m of [0, 1, 2]) await submitProof(ctx, c, m);

      // milestone 0: decisive approval (200 >= 198) -> finalize BEFORE the deadline
      await ctx.voting.openVotingRound(c, 0);
      await ctx.voting.connect(v1).castVote(c, 0, true);
      await ctx.voting.connect(v2).castVote(c, 0, true);
      expect(await ctx.voting.approvalReached(c, 0)).to.equal(true);
      await ctx.voting.finalizeRound(c, 0);
      expect((await ctx.voting.getRound(c, 0)).approved).to.equal(true);
      expect((await ctx.escrow.getMilestone(c, 0))[2]).to.equal(State.Timelocked);

      // milestone 1: identical votes -> finalize AFTER the deadline
      await ctx.voting.openVotingRound(c, 1);
      await ctx.voting.connect(v1).castVote(c, 1, true);
      await ctx.voting.connect(v2).castVote(c, 1, true);
      expect(await ctx.voting.approvalReached(c, 1)).to.equal(true);
      await time.increase(VOTING_PERIOD * 4); // predicate must not depend on time
      expect(await ctx.voting.approvalReached(c, 1)).to.equal(true);
      await ctx.voting.finalizeRound(c, 1);
      expect((await ctx.voting.getRound(c, 1)).approved).to.equal(true);
      expect((await ctx.escrow.getMilestone(c, 1))[2]).to.equal(State.Timelocked);
    });

    it("below threshold: cannot finalize early, and finalizes as rejected at the deadline", async () => {
      const ctx = await loadFixture(fullSystemFixture);
      const [v1, v2, v3] = ctx.verifiers;
      await stakeAll(ctx.registry, [v1, v2, v3]);
      const c = await newCampaign(ctx.escrow, ctx.deployer, ctx.beneficiary.address, [
        SMALL,
      ]);
      await ctx.escrow.connect(ctx.deployer).donate(c, { value: SMALL });
      await submitProof(ctx, c, 0);

      await ctx.voting.openVotingRound(c, 0);
      await ctx.voting.connect(v1).castVote(c, 0, true); // 100 < 198
      expect(await ctx.voting.approvalReached(c, 0)).to.equal(false);
      await expect(ctx.voting.finalizeRound(c, 0)).to.be.revertedWith(
        "round still active",
      );

      await time.increase(VOTING_PERIOD + 1);
      await ctx.voting.finalizeRound(c, 0);
      expect((await ctx.voting.getRound(c, 0)).approved).to.equal(false);
      expect((await ctx.escrow.getMilestone(c, 0))[2]).to.equal(State.Pending);
    });
  });

  describe("20% dispute threshold", () => {
    it("forwards to escrow.raiseDispute only once cumulative dispute weight reaches 20%", async () => {
      const ctx = await loadFixture(fullSystemFixture);
      const vs = ctx.verifiers; // 6 verifiers
      await stakeAll(ctx.registry, vs); // totalWeight 600 -> 20% = 120
      const c = await newCampaign(ctx.escrow, ctx.deployer, ctx.beneficiary.address, [
        SMALL,
      ]);
      await ctx.escrow.connect(ctx.deployer).donate(c, { value: SMALL });
      await submitProof(ctx, c, 0);

      // approve with 4 of 6 (400 >= 396) -> Timelocked, snapshot 600
      await runRound(ctx, c, 0, [vs[0], vs[1], vs[2], vs[3]]);
      expect((await ctx.escrow.getMilestone(c, 0))[2]).to.equal(State.Timelocked);

      // disputer 1: weight 100 < 120 -> recorded, NOT forwarded
      await expect(ctx.voting.connect(vs[4]).raiseDispute(c, 0))
        .to.emit(ctx.voting, "DisputeJoined")
        .and.not.to.emit(ctx.voting, "DisputeThresholdReached");
      expect((await ctx.voting.getRound(c, 0)).disputeForwarded).to.equal(false);
      expect((await ctx.escrow.getMilestone(c, 0))[2]).to.equal(State.Timelocked);

      // same verifier again, still below threshold -> "already disputed"
      await expect(ctx.voting.connect(vs[4]).raiseDispute(c, 0)).to.be.revertedWith(
        "already disputed",
      );

      // disputer 2: cumulative 200 >= 120 -> forwarded, milestone Disputed
      await expect(ctx.voting.connect(vs[5]).raiseDispute(c, 0))
        .to.emit(ctx.voting, "DisputeThresholdReached")
        .withArgs(c, 0n)
        .and.to.emit(ctx.escrow, "DisputeRaised");
      expect((await ctx.voting.getRound(c, 0)).disputeForwarded).to.equal(true);
      expect((await ctx.escrow.getMilestone(c, 0))[2]).to.equal(State.Disputed);

      // once forwarded, no further disputes from anyone
      await expect(ctx.voting.connect(vs[0]).raiseDispute(c, 0)).to.be.revertedWith(
        "dispute already forwarded",
      );
    });
  });

  describe("reputation adjustment after a round resolves", () => {
    it("aligned voters +5, misaligned -10 with a strike, pending-vote locks cleared", async () => {
      const ctx = await loadFixture(fullSystemFixture);
      const [v1, v2, v3] = ctx.verifiers;
      await stakeAll(ctx.registry, [v1, v2, v3]);
      const c = await newCampaign(ctx.escrow, ctx.deployer, ctx.beneficiary.address, [
        SMALL,
      ]);
      await ctx.escrow.connect(ctx.deployer).donate(c, { value: SMALL });
      await submitProof(ctx, c, 0);

      await ctx.voting.openVotingRound(c, 0);
      await ctx.voting.connect(v1).castVote(c, 0, true);
      await ctx.voting.connect(v2).castVote(c, 0, true);
      await ctx.voting.connect(v3).castVote(c, 0, false);
      // stakes locked during the round
      expect(await ctx.registry.pendingVotes(v1.address)).to.equal(1n);

      await expect(ctx.voting.finalizeRound(c, 0)).to.emit(ctx.voting, "VoterSettled");

      expect(await ctx.registry.reputationOf(v1.address)).to.equal(105n);
      expect(await ctx.registry.reputationOf(v2.address)).to.equal(105n);
      expect(await ctx.registry.reputationOf(v3.address)).to.equal(90n);
      expect(await ctx.registry.againstStrikes(v3.address)).to.equal(1n);
      for (const v of [v1, v2, v3])
        expect(await ctx.registry.pendingVotes(v.address)).to.equal(0n);
      expect(await ctx.registry.totalWeight()).to.equal(300n); // 105+105+90
    });

    it("three losing rounds slash the dissenter through the real flow", async () => {
      const ctx = await loadFixture(fullSystemFixture);
      const [A, B, C, D] = ctx.verifiers;
      await stakeAll(ctx.registry, [A, B, C, D]); // all rep 100
      const camp = await newCampaign(
        ctx.escrow,
        ctx.deployer,
        ctx.beneficiary.address,
        [SMALL, SMALL, SMALL],
      );
      await ctx.escrow.connect(ctx.deployer).donate(camp, { value: ethers.parseEther("1") });
      for (const m of [0, 1, 2]) await submitProof(ctx, camp, m);

      // each round: A,B,C approve (decisive), D rejects and loses
      await runRound(ctx, camp, 0, [A, B, C], [D]);
      await runRound(ctx, camp, 1, [A, B, C], [D]);
      await expect(runRound(ctx, camp, 2, [A, B, C], [D]))
        .to.emit(ctx.registry, "Slashed")
        .withArgs(D.address, ethers.parseEther("0.1"));

      expect(await ctx.registry.reputationOf(D.address)).to.equal(0n);
      expect(await ctx.registry.isVerifier(D.address)).to.equal(false);
      expect(await ctx.registry.stakedAmount(D.address)).to.equal(
        ethers.parseEther("0.9"),
      );
      // A,B,C: 100 -> 115 after three aligned rounds
      expect(await ctx.registry.totalWeight()).to.equal(345n);
      // slashed 0.1 ETH landed in the campaign balance
      const [, , balance] = await ctx.escrow.getCampaign(camp);
      expect(balance).to.equal(ethers.parseEther("1") + ethers.parseEther("0.1"));
    });
  });

  describe("proofCID snapshot at round-open", () => {
    it("pins the CID at open; a mid-round resubmission changes ProofRegistry but not the round", async () => {
      const ctx = await loadFixture(fullSystemFixture);
      const [v1, v2] = ctx.verifiers;
      await stakeAll(ctx.registry, [v1, v2]);
      const c = await newCampaign(ctx.escrow, ctx.deployer, ctx.beneficiary.address, [
        SMALL,
      ]);
      await ctx.escrow.connect(ctx.deployer).donate(c, { value: SMALL });

      await ctx.proofs.connect(ctx.beneficiary).submitProof(c, 0, "CID_A");
      await ctx.voting.openVotingRound(c, 0);
      expect((await ctx.voting.getRound(c, 0)).proofCID).to.equal("CID_A");

      // milestone is still Pending while the round is open -> resubmission allowed
      await ctx.proofs.connect(ctx.beneficiary).submitProof(c, 0, "CID_B");
      expect(await ctx.proofs.getProofCID(c, 0)).to.equal("CID_B"); // live value moved
      const [, , , pv] = await ctx.proofs.getProof(c, 0);
      expect(pv).to.equal(2n);

      // the open round is unchanged
      expect((await ctx.voting.getRound(c, 0)).proofCID).to.equal("CID_A");

      // and the round still resolves normally against the pinned CID
      await ctx.voting.connect(v1).castVote(c, 0, true);
      await ctx.voting.connect(v2).castVote(c, 0, true);
      await ctx.voting.finalizeRound(c, 0);
      expect((await ctx.voting.getRound(c, 0)).approved).to.equal(true);
      expect((await ctx.voting.getRound(c, 0)).proofCID).to.equal("CID_A");
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ProofRegistry
// ═════════════════════════════════════════════════════════════════════════════

describe("ProofRegistry", () => {
  it("only the campaign beneficiary may submit, with a non-empty CID, for a real milestone", async () => {
    const { proofs, beneficiary, outsider } = await loadFixture(proofRegistryFixture);
    await expect(
      proofs.connect(outsider).submitProof(0, 0, "cid"),
    ).to.be.revertedWith("not beneficiary");
    await expect(
      proofs.connect(beneficiary).submitProof(0, 0, ""),
    ).to.be.revertedWith("empty cid");
    await expect(
      proofs.connect(outsider).submitProof(99, 0, "cid"),
    ).to.be.revertedWith("no campaign");
    await expect(
      proofs.connect(beneficiary).submitProof(0, 9, "cid"),
    ).to.be.revertedWith("no milestone");
  });

  it("records CID + submitter + version and unblocks voting via hasProof", async () => {
    const { proofs, beneficiary } = await loadFixture(proofRegistryFixture);
    expect(await proofs.hasProof(0, 0)).to.equal(false);

    await expect(proofs.connect(beneficiary).submitProof(0, 0, "Qm-one"))
      .to.emit(proofs, "ProofSubmitted")
      .withArgs(0n, 0n, "Qm-one", beneficiary.address);

    expect(await proofs.hasProof(0, 0)).to.equal(true);
    expect(await proofs.getProofCID(0, 0)).to.equal("Qm-one");
    const [cid, submitter, ts, version] = await proofs.getProof(0, 0);
    expect(cid).to.equal("Qm-one");
    expect(submitter).to.equal(beneficiary.address);
    expect(ts).to.be.greaterThan(0n);
    expect(version).to.equal(1n);
  });

  it("allows resubmission while the milestone is Pending", async () => {
    const { proofs, beneficiary } = await loadFixture(proofRegistryFixture);
    await proofs.connect(beneficiary).submitProof(0, 0, "v1");
    await proofs.connect(beneficiary).submitProof(0, 0, "v2");
    expect(await proofs.getProofCID(0, 0)).to.equal("v2");
    const [, , , version] = await proofs.getProof(0, 0);
    expect(version).to.equal(2n);
  });

  it("freezes the CID once the milestone leaves Pending", async () => {
    const { escrow, proofs, mockMV, beneficiary } =
      await loadFixture(proofRegistryFixture);
    await proofs.connect(beneficiary).submitProof(0, 1, "v1");
    await escrow.connect(mockMV).startTimelock(0, 1); // milestone 1 -> Timelocked
    await expect(
      proofs.connect(beneficiary).submitProof(0, 1, "v2"),
    ).to.be.revertedWith("milestone not pending");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Regression — BUG #1 fix: applyVoteResult / adjustReputation no-op for a
// slashed-out (non-verifier) address, so a still-open round finalizing after the
// slash cannot re-accrue stale reputation or drift totalWeight on re-stake.
// ═════════════════════════════════════════════════════════════════════════════

describe("Regression: applyVoteResult on a slashed-out verifier (BUG #1 fix)", () => {
  it("does not accrue reputation for a non-verifier; totalWeight stays consistent on re-stake", async () => {
    const { registry, mockMV, D } = await loadFixture(registryFixture);
    await registry.connect(D).stake({ value: MIN_STAKE });

    // 3 misses -> slashed out (0.9 ETH left, reputation 0, not a verifier, weight 0)
    for (let i = 0; i < 3; i++)
      await registry.connect(mockMV).applyVoteResult(D.address, false, 0);
    expect(await registry.isVerifier(D.address)).to.equal(false);
    expect(await registry.reputationOf(D.address)).to.equal(0n);
    expect(await registry.totalWeight()).to.equal(0n);

    // A different round D also voted in finalizes AFTER the drop and settles D
    // as aligned -> applyVoteResult(D, true). D is no longer a verifier, so this
    // is now a no-op.
    await registry.connect(mockMV).applyVoteResult(D.address, true, 0);
    expect(await registry.reputationOf(D.address)).to.equal(0n);

    // adjustReputation on the same non-verifier is also a no-op.
    await registry.connect(mockMV).adjustReputation(D.address, 50);
    expect(await registry.reputationOf(D.address)).to.equal(0n);

    // D tops back up with the leftover 0.9 ETH -> fresh reputation 100.
    await registry.connect(D).stake({ value: ethers.parseEther("0.1") });
    expect(await registry.reputationOf(D.address)).to.equal(100n);

    // totalWeight == sum of active verifier reputations == 100.
    expect(await registry.totalWeight()).to.equal(100n);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// End-to-End Multi-Milestone & Governance Edge Cases
// ═════════════════════════════════════════════════════════════════════════════

describe("Full Multi-Milestone Lifecycle, Disputes & Unallocated Slashes", () => {
  it("handles a complex multi-milestone flow with release, dispute rejection, and unallocated slashes", async () => {
    const {
      escrow,
      registry,
      proofs,
      voting,
      deployer,
      beneficiary,
      verifiers,
      outsider,
    } = await loadFixture(fullSystemFixture);
    const [v1, v2, v3] = verifiers;

    // 1. Create a campaign with 2 milestones (1 ETH each)
    const m0Amount = ethers.parseEther("1");
    const m1Amount = ethers.parseEther("1");
    await escrow.connect(deployer).createCampaign(
      beneficiary.address,
      ["Milestone 1: Solar Panel Setup", "Milestone 2: Battery Inverters"],
      [m0Amount, m1Amount],
    );
    const campaignId = 0n;

    // 2. Fund campaign with 2 ETH
    await escrow.connect(outsider).donate(campaignId, { value: ethers.parseEther("2") });
    expect(await escrow.availableBalance(campaignId)).to.equal(ethers.parseEther("2"));

    // 3. Verifiers stake (v1, v2, v3)
    await registry.connect(v1).stake({ value: MIN_STAKE });
    await registry.connect(v2).stake({ value: MIN_STAKE });
    await registry.connect(v3).stake({ value: MIN_STAKE });
    expect(await registry.totalWeight()).to.equal(300n); // 100 each

    // 4. Milestone 0: Submit proof, open round, vote approve, finalize, elapse, release
    await proofs.connect(beneficiary).submitProof(campaignId, 0, "ipfs://QmSolarProof");
    await voting.connect(v1).openVotingRound(campaignId, 0);

    await voting.connect(v1).castVote(campaignId, 0, true);
    await voting.connect(v2).castVote(campaignId, 0, true);
    // 200/300 = 66.6% >= 66% approval reached!
    expect(await voting.approvalReached(campaignId, 0)).to.equal(true);

    await voting.connect(outsider).finalizeRound(campaignId, 0);
    const m0AfterRound = await escrow.getMilestone(campaignId, 0);
    expect(m0AfterRound.state).to.equal(State.Timelocked);

    // Fast-forward 48 hours for timelock
    await time.increase(TIMELOCK + 1);

    // Release milestone 0 to beneficiary
    const benefBalBefore = await ethers.provider.getBalance(beneficiary.address);
    await escrow.connect(outsider).release(campaignId, 0);
    const benefBalAfter = await ethers.provider.getBalance(beneficiary.address);
    expect(benefBalAfter - benefBalBefore).to.equal(m0Amount);

    const m0Released = await escrow.getMilestone(campaignId, 0);
    expect(m0Released.state).to.equal(State.Released);

    // 5. Milestone 1: Submit proof, open round, approve, but dispute raised during timelock!
    await proofs.connect(beneficiary).submitProof(campaignId, 1, "ipfs://QmInverterProof");
    await voting.connect(v2).openVotingRound(campaignId, 1);

    await voting.connect(v1).castVote(campaignId, 1, true);
    await voting.connect(v2).castVote(campaignId, 1, true);
    await voting.connect(outsider).finalizeRound(campaignId, 1);

    const m1AfterRound = await escrow.getMilestone(campaignId, 1);
    expect(m1AfterRound.state).to.equal(State.Timelocked);

    // Before timelock elapses, verifier v3 (weight >= 20%) raises dispute
    await voting.connect(v3).raiseDispute(campaignId, 1);
    const m1Disputed = await escrow.getMilestone(campaignId, 1);
    expect(m1Disputed.state).to.equal(State.Disputed);

    // Even if 48 hours pass, release is blocked
    await time.increase(TIMELOCK + 1);
    await expect(escrow.connect(outsider).release(campaignId, 1)).to.be.revertedWith(
      "milestone not releasable",
    );

    // Owner resolves dispute: reject (uphold = false)
    await escrow.connect(deployer).resolveDispute(campaignId, 1, false);
    const m1Rejected = await escrow.getMilestone(campaignId, 1);
    expect(m1Rejected.state).to.equal(State.Rejected);

    // Reserved amount was freed back to available balance!
    expect(await escrow.availableBalance(campaignId)).to.equal(ethers.parseEther("1"));

    // 6. Slashed funds credited to non-existent campaign go to unallocatedSlashed and can be swept
    // Simulate direct call from verifierRegistry with unknown campaignId 999
    // First fund registry to simulate slash
    await networkHelpers.setBalance(await registry.getAddress(), ethers.parseEther("1"));
    const regSigner = await ethers.getImpersonatedSigner(await registry.getAddress());
    await escrow.connect(regSigner).creditSlashed(999, { value: ethers.parseEther("0.1") });
    expect(await escrow.unallocatedSlashed()).to.equal(ethers.parseEther("0.1"));

    const sweepRecipient = outsider.address;
    const recipientBalBefore = await ethers.provider.getBalance(sweepRecipient);
    await escrow.connect(deployer).sweepUnallocated(sweepRecipient);
    const recipientBalAfter = await ethers.provider.getBalance(sweepRecipient);
    expect(recipientBalAfter - recipientBalBefore).to.equal(ethers.parseEther("0.1"));
    expect(await escrow.unallocatedSlashed()).to.equal(0n);
  });
});

