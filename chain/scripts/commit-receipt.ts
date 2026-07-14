/**
 * Kickr receipt committer (build.md §6).
 *
 * Reads a JSON receipt on stdin, hashes it (sha256), and sends a Solana
 * devnet transaction whose Memo instruction carries the hash. Prints the
 * transaction signature to stdout. Exit code != 0 on failure — the backend
 * queue retries up to 3x and then stores a null signature.
 *
 * Keypair: SOLANA_KEYPAIR env (base58 secret key) or chain/.keys/txline-devnet.json.
 * Usage: echo '{"market_id": ...}' | npx tsx scripts/commit-receipt.ts open
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
const WALLET_PATH = path.resolve(__dirname, "..", ".keys", "txline-devnet.json");

function loadKeypair(): Keypair {
  if (process.env.SOLANA_KEYPAIR) {
    return Keypair.fromSecretKey(anchor.utils.bytes.bs58.decode(process.env.SOLANA_KEYPAIR));
  }
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, "utf8")));
  return Keypair.fromSecretKey(secret);
}

async function main() {
  const phase = process.argv[2] ?? "open";
  const receiptJson = fs.readFileSync(0, "utf8"); // stdin
  JSON.parse(receiptJson); // validate it is JSON before committing a hash of it
  const hash = createHash("sha256").update(receiptJson).digest("hex");

  const payer = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const memo = `kickr:${phase}:${hash}`;
  const tx = new Transaction().add(
    new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memo, "utf8"),
    })
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  process.stdout.write(sig);
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
