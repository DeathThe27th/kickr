/**
 * TxLINE access activation for Kickr — devnet or mainnet.
 *
 * Flow (per https://txline.txodds.com/documentation/quickstart):
 *   1. Create/load a Solana keypair (devnet airdrops; mainnet must be funded).
 *   2. POST /auth/guest/start -> guest JWT.
 *   3. On-chain `subscribe(SERVICE_LEVEL_ID, weeks=4)` with SELECTED_LEAGUES=[].
 *   4. Sign `${txSig}:${leagues.join(",")}:${jwt}` (ed25519 detached, base64).
 *   5. POST /api/token/activate -> long-lived API token.
 *
 * The World Cup + International Friendlies bundle is 0 TxL on BOTH networks;
 * only the leagues bundles cost money. Mainnet still needs real SOL for gas
 * and Token-2022 account rent (~0.05 SOL covers it).
 *
 * The subscription EXPIRES after DURATION_WEEKS (28 days) — it is not a
 * one-off purchase. Re-run to renew before `expiresAt` or data requests 401.
 *
 * Credentials are printed and saved to chain/.txline-credentials.<network>.json.
 * Re-running with an existing API token only renews the guest JWT (no new
 * on-chain subscription). Pass --force to redo the full flow.
 *
 * Run:  TXLINE_NETWORK=mainnet npm run activate-txline   (from chain/)
 *       npm run activate-txline                          (defaults to devnet)
 */

import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import axios from "axios";
import nacl from "tweetnacl";
import * as fs from "fs";
import * as path from "path";

// --- Network config -------------------------------------------------------
// TxLINE requires the Solana RPC, program ID, guest JWT host and activation
// endpoint to all belong to the SAME network ("Do not activate a mainnet
// transaction on the devnet API host"), so they travel as one record instead
// of as loose env vars that can drift out of sync.
// Values: https://txline.txodds.com/documentation/programs/{mainnet,devnet}
type Network = "mainnet" | "devnet";

const NETWORKS = {
  mainnet: {
    apiOrigin: "https://txline.txodds.com",
    rpc: "https://api.mainnet-beta.solana.com",
    programId: "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA",
    txlMint: "Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL",
    // 12 and 1 are the same free World Cup + Int'l Friendlies bundle, but on
    // mainnet level 1 is 60s-delayed. A 60s delay makes in-play micro markets
    // unsettleable, so real-time (12) is the only viable level here.
    serviceLevelId: 12,
    explorerSuffix: "",
  },
  devnet: {
    apiOrigin: "https://txline-dev.txodds.com",
    rpc: "https://api.devnet.solana.com",
    programId: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
    txlMint: "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG",
    serviceLevelId: 1, // zero-delay on devnet
    explorerSuffix: "?cluster=devnet",
  },
} as const;

const NETWORK = (process.env.TXLINE_NETWORK ?? "devnet") as Network;
if (!(NETWORK in NETWORKS)) {
  throw new Error(`TXLINE_NETWORK must be "mainnet" or "devnet" — got "${NETWORK}"`);
}
const NET = NETWORKS[NETWORK];

const API_ORIGIN = process.env.TXLINE_API_ORIGIN ?? NET.apiOrigin;
const API_BASE_URL = `${API_ORIGIN}/api`;
const JWT_URL = `${API_ORIGIN}/auth/guest/start`;
// Deliberately NOT SOLANA_RPC: that one belongs to the receipt committer, which
// stays on devnet. Subscribing on mainnet must not drag receipts onto mainnet.
const SOLANA_RPC = process.env.TXLINE_SOLANA_RPC ?? NET.rpc;
const TXL_MINT = new PublicKey(NET.txlMint);

const SERVICE_LEVEL_ID = Number(process.env.TXLINE_SERVICE_LEVEL ?? NET.serviceLevelId);
const DURATION_WEEKS = 4; // must be a multiple of 4; the subscription EXPIRES after this
const SELECTED_LEAGUES: number[] = [];

const CHAIN_DIR = path.resolve(__dirname, "..");
// Per-network wallet: a devnet wallet holds only airdropped SOL and is useless
// on mainnet. Devnet keeps its original path so the receipt committer, which
// reads the same file, is unaffected.
const WALLET_PATH =
  process.env.TXLINE_WALLET ?? path.join(CHAIN_DIR, ".keys", `txline-${NETWORK}.json`);
const CREDENTIALS_PATH = path.join(CHAIN_DIR, `.txline-credentials.${NETWORK}.json`);
// Runs before the mainnet switch wrote devnet credentials without a suffix.
const LEGACY_CREDENTIALS_PATH = path.join(CHAIN_DIR, ".txline-credentials.json");
const IDL_PATH = path.join(CHAIN_DIR, "idl", "txoracle.json");

function loadOrCreateKeypair(): Keypair {
  // Highest priority: SOLANA_KEYPAIR env (base58-encoded secret key, build.md §10),
  // e.g. pasted into .env. Falls back to the local wallet file.
  if (process.env.SOLANA_KEYPAIR) {
    const kp = Keypair.fromSecretKey(anchor.utils.bytes.bs58.decode(process.env.SOLANA_KEYPAIR));
    console.log(`Loaded wallet ${kp.publicKey.toBase58()} from SOLANA_KEYPAIR env`);
    return kp;
  }
  if (fs.existsSync(WALLET_PATH)) {
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, "utf8")));
    const kp = Keypair.fromSecretKey(secret);
    console.log(`Loaded wallet ${kp.publicKey.toBase58()} from ${WALLET_PATH}`);
    return kp;
  }
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(WALLET_PATH), { recursive: true });
  fs.writeFileSync(WALLET_PATH, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  console.log(`Created new wallet ${kp.publicKey.toBase58()} at ${WALLET_PATH}`);
  return kp;
}

async function ensureSol(connection: Connection, kp: Keypair): Promise<void> {
  const balance = await connection.getBalance(kp.publicKey);
  console.log(`Wallet balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  if (balance >= 0.05 * LAMPORTS_PER_SOL) return;
  if (NETWORK === "mainnet") {
    throw new Error(
      `Wallet ${kp.publicKey.toBase58()} holds ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL on mainnet.\n` +
        `There is no faucet on mainnet — fund it with ~0.05 real SOL to cover the subscribe fee and the\n` +
        `Token-2022 account rent, then re-run. The World Cup tier itself costs 0 TxL.`
    );
  }
  console.log("Balance low — requesting 1 SOL devnet airdrop...");
  try {
    const sig = await connection.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
    console.log("Airdrop confirmed.");
  } catch (err) {
    throw new Error(
      `Devnet airdrop failed (faucet is often rate-limited). Fund ${kp.publicKey.toBase58()} manually ` +
        `via https://faucet.solana.com and re-run. Underlying error: ${err}`
    );
  }
}

async function getGuestJwt(): Promise<string> {
  const res = await axios.post(JWT_URL);
  const jwt = res.data.token;
  if (!jwt) throw new Error(`Guest auth returned no token: ${JSON.stringify(res.data)}`);
  console.log("Guest JWT acquired.");
  return jwt;
}

async function subscribeOnChain(connection: Connection, user: Keypair): Promise<string> {
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(user), {
    commitment: "confirmed",
  });
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  // The bundled IDL carries the devnet address. Mainnet runs the same program
  // under a different ID, so the network's ID has to win or every PDA below is
  // derived against the wrong program.
  idl.address = NET.programId;
  const program = new anchor.Program(idl, provider);
  console.log(`Program ID: ${program.programId.toBase58()} (${NETWORK})`);

  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    program.programId
  );
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")],
    program.programId
  );
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    TXL_MINT,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const userTokenAccount = getAssociatedTokenAddressSync(
    TXL_MINT,
    user.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // The subscribe instruction debits the user's TxL ATA (0 TxL for the free
  // tier, but the account must exist).
  if (!(await connection.getAccountInfo(userTokenAccount))) {
    console.log("Creating user TxL Token-2022 associated token account...");
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        user.publicKey,
        userTokenAccount,
        user.publicKey,
        TXL_MINT,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await anchor.web3.sendAndConfirmTransaction(connection, tx, [user], { commitment: "confirmed" });
    console.log("Token account created.");
  }

  console.log(
    `Subscribing on-chain (${NETWORK}): service level ${SERVICE_LEVEL_ID}, ` +
      `${DURATION_WEEKS} weeks, leagues=[${SELECTED_LEAGUES.join(",")}]`
  );
  const tx = await (program.methods as any)
    .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
    .accounts({
      user: user.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: TXL_MINT,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  const latest = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.feePayer = user.publicKey;
  tx.sign(user);
  const txSig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature: txSig, ...latest }, "confirmed");
  console.log(`Subscription confirmed: ${txSig}`);
  console.log(`  https://explorer.solana.com/tx/${txSig}${NET.explorerSuffix}`);
  return txSig;
}

async function activateApiToken(user: Keypair, txSig: string, jwt: string): Promise<string> {
  const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
  const signatureBytes = nacl.sign.detached(new TextEncoder().encode(messageString), user.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  const res = await axios.post(
    `${API_BASE_URL}/token/activate`,
    { txSig, walletSignature, leagues: SELECTED_LEAGUES },
    { headers: { Authorization: `Bearer ${jwt}` } }
  );
  const apiToken = res.data.token || res.data;
  if (!apiToken || typeof apiToken !== "string") {
    throw new Error(`Activation returned no token: ${JSON.stringify(res.data)}`);
  }
  console.log("API token activated.");
  return apiToken;
}

async function main() {
  const force = process.argv.includes("--force");
  const user = loadOrCreateKeypair();

  // Reuse an existing long-lived API token; only the short-lived guest JWT
  // needs renewing (matches the official examples' behavior).
  const existingPath = fs.existsSync(CREDENTIALS_PATH)
    ? CREDENTIALS_PATH
    : NETWORK === "devnet" && fs.existsSync(LEGACY_CREDENTIALS_PATH)
      ? LEGACY_CREDENTIALS_PATH
      : null;
  if (!force && existingPath) {
    const existing = JSON.parse(fs.readFileSync(existingPath, "utf8"));
    if (existing.apiToken) {
      console.log("Existing API token found — renewing guest JWT only (use --force to resubscribe).");
      const jwt = await getGuestJwt();
      const creds = { ...existing, jwt, renewedAt: new Date().toISOString() };
      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
      printCredentials(creds.jwt, creds.apiToken);
      return;
    }
  }

  const connection = new Connection(SOLANA_RPC, "confirmed");
  await ensureSol(connection, user);
  const jwt = await getGuestJwt();
  const txSig = await subscribeOnChain(connection, user);
  const apiToken = await activateApiToken(user, txSig, jwt);

  const creds = {
    network: NETWORK,
    wallet: user.publicKey.toBase58(),
    txSig,
    serviceLevelId: SERVICE_LEVEL_ID,
    leagues: SELECTED_LEAGUES,
    jwt,
    apiToken,
    activatedAt: new Date().toISOString(),
    // The subscription lapses at this point — data requests start 401ing.
    expiresAt: new Date(Date.now() + DURATION_WEEKS * 7 * 86_400_000).toISOString(),
  };
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
  console.log(`Credentials saved to ${CREDENTIALS_PATH}`);
  printCredentials(jwt, apiToken);
}

function printCredentials(jwt: string, apiToken: string) {
  console.log(`\n================ TxLINE ${NETWORK} credentials ================`);
  console.log(`TXLINE_API_ORIGIN=${API_ORIGIN}`);
  console.log(`TXLINE_JWT=${jwt}`);
  console.log(`TXLINE_API_TOKEN=${apiToken}`);
  console.log("============================================================");
  console.log("Data requests: Authorization: Bearer <TXLINE_JWT>  +  X-Api-Token: <TXLINE_API_TOKEN>");
  console.log("On a 401, renew the JWT from POST /auth/guest/start and retry with the same API token.");
}

main().then(
  () => process.exit(0),
  (err) => {
    if (axios.isAxiosError(err)) {
      console.error("Request failed:", err.response?.status, err.response?.data ?? err.message);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
);
