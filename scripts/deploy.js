/**
 * Deploy IntentBridge contracts
 * ==============================
 * Deploys three simulated rollup environments with distinct characteristics,
 * then deploys the IntentRegistry.
 *
 * Usage:
 *   npx hardhat node               (terminal 1)
 *   npx hardhat run scripts/deploy.js --network localhost   (terminal 2)
 */

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // ── Deploy test tokens ─────────────────────────────────────────────────────
  const Token = await hre.ethers.getContractFactory("MockToken");
  const usdc  = await Token.deploy("Mock USDC", "mUSDC");
  const eth   = await Token.deploy("Mock WETH", "mWETH");
  await usdc.waitForDeployment();
  await eth.waitForDeployment();
  console.log("mUSDC :", await usdc.getAddress());
  console.log("mWETH :", await eth.getAddress());

  // ── Deploy three simulated rollups ─────────────────────────────────────────
  //
  //  RollupA — ArbiNova (Arbitrum-style optimistic)
  //    • Lowest base fee, highest latency
  //    • Best for non-urgent, cost-sensitive transactions
  //
  //  RollupB — OptiSwift (Optimism-style optimistic)
  //    • Mid-range fee and latency
  //    • General-purpose balanced option
  //
  //  RollupC — ZkRapid (ZK rollup)
  //    • Highest base fee (proof cost), lowest latency
  //    • Best for time-sensitive, high-value transactions

  const Rollup = await hre.ethers.getContractFactory("MockRollup");

  const rollupA = await Rollup.deploy("ArbiNova",  "optimistic", 5,  2000, 10);
  const rollupB = await Rollup.deploy("OptiSwift", "optimistic", 12, 800,  35);
  const rollupC = await Rollup.deploy("ZkRapid",   "zk",         30, 300,  55);

  await rollupA.waitForDeployment();
  await rollupB.waitForDeployment();
  await rollupC.waitForDeployment();

  const addrA = await rollupA.getAddress();
  const addrB = await rollupB.getAddress();
  const addrC = await rollupC.getAddress();

  console.log("RollupA (ArbiNova) :", addrA);
  console.log("RollupB (OptiSwift):", addrB);
  console.log("RollupC (ZkRapid)  :", addrC);

  // ── Deploy IntentRegistry ─────────────────────────────────────────────────
  const Registry = await hre.ethers.getContractFactory("IntentRegistry");
  const registry = await Registry.deploy(deployer.address);
  await registry.waitForDeployment();
  const addrReg = await registry.getAddress();
  console.log("IntentRegistry     :", addrReg);

  // ── Mint test tokens ──────────────────────────────────────────────────────
  const amount = hre.ethers.parseEther("1000000");
  await usdc.mint(deployer.address, amount);
  await eth.mint(deployer.address, amount);
  console.log("Minted 1M mUSDC and 1M mWETH to deployer");

  // ── Print config for router/frontend ─────────────────────────────────────
  console.log("\n── Paste into router/.env ──────────────────────────────");
  console.log(`REGISTRY_ADDRESS=${addrReg}`);
  console.log(`ROLLUP_A_ADDRESS=${addrA}`);
  console.log(`ROLLUP_B_ADDRESS=${addrB}`);
  console.log(`ROLLUP_C_ADDRESS=${addrC}`);
  console.log(`TOKEN_USDC=${await usdc.getAddress()}`);
  console.log(`TOKEN_WETH=${await eth.getAddress()}`);
  console.log(`RPC_URL=http://127.0.0.1:8545`);
  console.log(`PRIVATE_KEY=${deployer.address}`);
  console.log("────────────────────────────────────────────────────────\n");
}

main().catch(e => { console.error(e); process.exit(1); });
