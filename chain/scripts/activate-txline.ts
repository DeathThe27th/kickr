/**
 * One-time TxLINE devnet access activation for Kickr.
 *
 * Flow (per https://txline-docs.txodds.com/documentation/quickstart and the
 * runnable devnet examples in github.com/txodds/tx-on-chain):
 *   1. Create/load a Solana devnet keypair (airdrop SOL if the wallet is empty).
 *   2. POST /auth/guest/start -> guest JWT.
 *   3. On-chain `subscribe(SERVICE_LEVEL_ID=1, weeks=4)` with SELECTED_LEAGUES=[]
 *      (free World Cup + International Friendlies tier, zero TxL cost).
 *   4. Sign `${txSig}:${leagues.join(",")}:${jwt}` (ed25519 detached, base64).
 *   5. POST /api/token/activate -> long-lived API token.
 *
 * Credentials are printed and saved to chain/.txline-credentials.json.
 * Re-running with an existing API token only renews the guest JWT (no new
 * on-chain subscription). Pass --force to redo the full flow.
 *
 * Run:  npm run activate-txline   (from chain/)
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

// --- Devnet constants (build.md §2) ---
const API_ORIGIN = process.env.TXLINE_API_ORIGIN ?? "https://txline-dev.txodds.com";
const API_BASE_URL = `${API_ORIGIN}/api`;
const JWT_URL = `${API_ORIGIN}/auth/guest/start`;
const SOLANA_RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
const TXL_MINT = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");

const SERVICE_LEVEL_ID = 1; // free World Cup tier (devnet)
const DURATION_WEEKS = 4; // must be a multiple of 4
const SELECTED_LEAGUES: number[] = [];

const CHAIN_DIR = path.resolve(__dirname, "..");
const WALLET_PATH = process.env.TXLINE_WALLET ?? path.join(CHAIN_DIR, ".keys", "txline-devnet.json");
const CREDENTIALS_PATH = path.join(CHAIN_DIR, ".txline-credentials.json");
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
  const program = new anchor.Program(idl, provider);
  console.log(`Program ID: ${program.programId.toBase58()}`);

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
    `Subscribing on-chain: service level ${SERVICE_LEVEL_ID} (free World Cup tier), ` +
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
  console.log(`  https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
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
  if (!force && fs.existsSync(CREDENTIALS_PATH)) {
    const existing = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
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
    wallet: user.publicKey.toBase58(),
    txSig,
    serviceLevelId: SERVICE_LEVEL_ID,
    leagues: SELECTED_LEAGUES,
    jwt,
    apiToken,
    activatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
  console.log(`Credentials saved to ${CREDENTIALS_PATH}`);
  printCredentials(jwt, apiToken);
}

function printCredentials(jwt: string, apiToken: string) {
  console.log("\n================ TxLINE devnet credentials ================");
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
