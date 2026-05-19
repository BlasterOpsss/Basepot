/**
 * RugPot Buy Bot
 * Automatically buys shares at the start of each new round.
 *
 * SETUP:
 *   1. npm install
 *   2. Copy .env.example to .env and fill in your values
 *   3. node bot.js
 */

const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const { AnchorProvider, Program, BN, setProvider } = require("@coral-xyz/anchor");
const bs58 = require("bs58");
const dotenv = require("dotenv");

dotenv.config();

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const CONFIG = {
  // RugPot program on Solana mainnet
  PROGRAM_ID: "552HLD8APrtVRHkRvgkKiZw48gsLdiTXC3SS5kDLd2ka",

  // How much SOL to spend buying shares each round
  BUY_AMOUNT_SOL: parseFloat(process.env.BUY_AMOUNT_SOL || "0.1"),

  // RPC endpoint — use a fast paid RPC for best results (e.g. Helius, QuickNode)
  RPC_URL: process.env.RPC_URL || "https://api.mainnet-beta.solana.com",

  // How often to poll for a new round (ms)
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || "3000"),

  // Slippage tolerance in basis points (100 = 1%)
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS || "200"),
};

// ─── WALLET ──────────────────────────────────────────────────────────────────

function loadWallet() {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) {
    throw new Error("WALLET_PRIVATE_KEY not set in .env");
  }
  try {
    // Support both base58 and JSON array formats
    if (key.startsWith("[")) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key)));
    }
    return Keypair.fromSecretKey(bs58.decode(key));
  } catch (e) {
    throw new Error("Invalid WALLET_PRIVATE_KEY format. Use base58 or JSON array.");
  }
}

// ─── RUGPOT CLIENT ───────────────────────────────────────────────────────────

class RugPotBot {
  constructor(connection, wallet) {
    this.connection = connection;
    this.wallet = wallet;
    this.programId = new PublicKey(CONFIG.PROGRAM_ID);
    this.lastRoundId = null;
    this.buyCount = 0;
  }

  log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  }

  // Derive the global config PDA — holds pointer to current round
  getGlobalConfigPDA() {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global_config")],
      this.programId
    );
    return pda;
  }

  // Derive the current round PDA
  getRoundPDA(roundId) {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("round"), Buffer.from(roundId.toString())],
      this.programId
    );
    return pda;
  }

  // Fetch and decode the global config account to get current round ID
  async getCurrentRoundId() {
    try {
      const configPDA = this.getGlobalConfigPDA();
      const accountInfo = await this.connection.getAccountInfo(configPDA);

      if (!accountInfo) {
        this.log("⚠️  Global config account not found. Program ID may be wrong or not yet initialized.");
        return null;
      }

      // The round ID is typically stored in the first few bytes after the discriminator (8 bytes)
      // Anchor discriminator = 8 bytes, then u64 round_id = 8 bytes
      const data = accountInfo.data;
      if (data.length < 16) {
        this.log("⚠️  Account data too short to parse.");
        return null;
      }

      // Read u64 little-endian at offset 8 (after discriminator)
      const roundId = data.readBigUInt64LE(8);
      return roundId.toString();
    } catch (e) {
      this.log(`Error fetching round ID: ${e.message}`);
      return null;
    }
  }

  // Fetch round state account
  async getRoundState(roundId) {
    try {
      const roundPDA = this.getRoundPDA(roundId);
      const accountInfo = await this.connection.getAccountInfo(roundPDA);
      if (!accountInfo) return null;

      // Parse key fields from round account data
      // Layout (Anchor): 8 discriminator | u64 round_id | u64 pot_lamports | bool is_active | ...
      const data = accountInfo.data;
      const potLamports = data.readBigUInt64LE(16); // offset 16
      const isActive = data[24] === 1;               // offset 24

      return {
        address: roundPDA.toBase58(),
        potSol: Number(potLamports) / LAMPORTS_PER_SOL,
        isActive,
      };
    } catch (e) {
      this.log(`Error fetching round state: ${e.message}`);
      return null;
    }
  }

  // Build and send the buy transaction
  async buyShares(roundId) {
    const lamports = Math.floor(CONFIG.BUY_AMOUNT_SOL * LAMPORTS_PER_SOL);
    const roundPDA = this.getRoundPDA(roundId);
    const configPDA = this.getGlobalConfigPDA();

    // Derive the vault PDA for this round
    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(roundId.toString())],
      this.programId
    );

    this.log(`🛒 Buying ${CONFIG.BUY_AMOUNT_SOL} SOL of shares in round ${roundId}...`);
    this.log(`   Round PDA : ${roundPDA.toBase58()}`);
    this.log(`   Vault PDA : ${vaultPDA.toBase58()}`);

    try {
      // Build the buy instruction data
      // Anchor instruction discriminator for "buy_shares" = sha256("global:buy_shares")[0..8]
      const discriminator = Buffer.from([
        0x66, 0x06, 0x35, 0x23, 0x4a, 0x99, 0x3f, 0xb5, // placeholder — update after IDL fetch
      ]);

      const amountBuffer = Buffer.alloc(8);
      amountBuffer.writeBigUInt64LE(BigInt(lamports));

      const instructionData = Buffer.concat([discriminator, amountBuffer]);

      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash("confirmed");

      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer: this.wallet.publicKey,
      });

      tx.add({
        programId: this.programId,
        keys: [
          { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: configPDA,             isSigner: false, isWritable: true },
          { pubkey: roundPDA,              isSigner: false, isWritable: true },
          { pubkey: vaultPDA,              isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: instructionData,
      });

      const sig = await sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
        commitment: "confirmed",
        maxRetries: 3,
      });

      this.buyCount++;
      this.log(`✅ Buy #${this.buyCount} confirmed! Tx: https://solscan.io/tx/${sig}`);
      return sig;
    } catch (e) {
      this.log(`❌ Buy failed: ${e.message}`);
      if (e.logs) {
        this.log("Program logs:");
        e.logs.forEach((l) => this.log(`  ${l}`));
      }
      return null;
    }
  }

  async checkBalance() {
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    return balance / LAMPORTS_PER_SOL;
  }

  // Main loop
  async run() {
    this.log("🤖 RugPot Buy Bot starting...");
    this.log(`   Wallet  : ${this.wallet.publicKey.toBase58()}`);
    this.log(`   Program : ${CONFIG.PROGRAM_ID}`);
    this.log(`   Buy amt : ${CONFIG.BUY_AMOUNT_SOL} SOL per round`);
    this.log(`   RPC     : ${CONFIG.RPC_URL}`);

    const balance = await this.checkBalance();
    this.log(`   Balance : ${balance.toFixed(4)} SOL`);

    if (balance < CONFIG.BUY_AMOUNT_SOL + 0.01) {
      this.log("⚠️  Warning: Low balance. Make sure you have enough SOL for buys + fees.");
    }

    this.log("\n👀 Watching for new rounds...\n");

    while (true) {
      try {
        const roundId = await this.getCurrentRoundId();

        if (roundId === null) {
          this.log("Could not fetch round ID. Retrying...");
          await sleep(CONFIG.POLL_INTERVAL_MS);
          continue;
        }

        // New round detected
        if (roundId !== this.lastRoundId) {
          this.log(`🔔 New round detected: ${roundId}`);
          this.lastRoundId = roundId;

          const state = await getRoundState(roundId);
          if (state) {
            this.log(`   Pot size : ${state.potSol.toFixed(4)} SOL`);
            this.log(`   Active   : ${state.isActive}`);
          }

          // Buy immediately
          await this.buyShares(roundId);

          const newBalance = await this.checkBalance();
          this.log(`   Balance after buy: ${newBalance.toFixed(4)} SOL\n`);
        }
      } catch (e) {
        this.log(`Unexpected error: ${e.message}`);
      }

      await sleep(CONFIG.POLL_INTERVAL_MS);
    }
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

async function main() {
  const wallet = loadWallet();
  const connection = new Connection(CONFIG.RPC_URL, "confirmed");
  const bot = new RugPotBot(connection, wallet);
  await bot.run();
}

main().catch((e) => {
  console.error("Fatal error:", e.message);
  process.exit(1);
});
              
