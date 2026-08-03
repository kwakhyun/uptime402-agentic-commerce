import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  address,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  signatureBytes,
  type TransactionSigner,
} from "@solana/kit";
import {
  DEVNET_GENESIS_HASH,
  DEVNET_USDC_MINT,
  type KeypairPathPolicy,
} from "@uptime402/payments";
import { describe, expect, it, vi } from "vitest";

import {
  OFFICIAL_SOLANA_DEVNET_RPC_URL,
  ensureDevnetVendorUsdcAta,
  parseVendorAtaCliArguments,
  type VendorAtaSetupInput,
} from "../scripts/ensure-devnet-vendor-usdc-ata.js";

const PAYER = "5ZT11fqnqaZPbWLqx5o4PCNSisXLKV1YFtNUxjQSGPHu";
const PAYEE = "GKW6kwSgTY1KkMi4ygAbZH1gZ13mYHfQJjrCASqYodmk";
const PAYEE_ATA = "7XiW3QKwGEbBzCfZALeoNKCYSaLcBzqenB9YtGT6Z74J";
const BLOCKHASH = "11111111111111111111111111111111";
const SETUP_SIGNATURE = "1".repeat(64);

type RpcRequest = Readonly<{
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: readonly unknown[];
}>;

function parseRpcRequest(init: RequestInit | undefined): RpcRequest {
  if (typeof init?.body !== "string") throw new TypeError("Expected string JSON-RPC body");
  const parsed: unknown = JSON.parse(init.body);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("jsonrpc" in parsed) ||
    parsed.jsonrpc !== "2.0" ||
    !("id" in parsed) ||
    typeof parsed.id !== "number" ||
    !("method" in parsed) ||
    typeof parsed.method !== "string" ||
    !("params" in parsed) ||
    !Array.isArray(parsed.params)
  ) {
    throw new TypeError("Invalid JSON-RPC request");
  }
  return {
    jsonrpc: "2.0",
    id: parsed.id,
    method: parsed.method,
    params: parsed.params,
  };
}

function rpcResponse(request: RpcRequest, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function tokenAccount(owner: string, amount = "0"): unknown {
  return {
    context: { slot: 200 },
    value: {
      data: {
        program: "spl-token",
        parsed: {
          type: "account",
          info: {
            mint: DEVNET_USDC_MINT,
            owner,
            state: "initialized",
            tokenAmount: { amount, decimals: 6 },
          },
        },
      },
      executable: false,
      owner: TOKEN_PROGRAM_ADDRESS,
    },
  };
}

function baseInput(execute: boolean): VendorAtaSetupInput {
  return {
    execute,
    rpcUrl: OFFICIAL_SOLANA_DEVNET_RPC_URL,
    signerPath: "/ignored/private/executor-keypair.json",
    signerRoot: "/ignored/private",
    payer: PAYER,
    payee: PAYEE,
    mint: DEVNET_USDC_MINT,
    ...(execute
      ? {
          expectedPayer: PAYER,
          expectedPayee: PAYEE,
          expectedMint: DEVNET_USDC_MINT,
          expectedAta: PAYEE_ATA,
        }
      : {}),
  };
}

function fakePayerSigner(): TransactionSigner {
  return {
    address: address(PAYER),
    signTransactions: async (transactions) =>
      transactions.map(() => ({
        [address(PAYER)]: signatureBytes(new Uint8Array(64)),
      })),
  };
}

describe("safe Devnet vendor USDC ATA setup", () => {
  it("accepts pnpm's optional argument separator without weakening execute confirmations", () => {
    const executeArguments = [
      "--execute",
      "--expected-payer",
      PAYER,
      "--expected-payee",
      PAYEE,
      "--expected-mint",
      DEVNET_USDC_MINT,
      "--expected-ata",
      PAYEE_ATA,
    ] as const;

    expect(parseVendorAtaCliArguments(executeArguments)).toEqual({
      execute: true,
      expectedPayer: PAYER,
      expectedPayee: PAYEE,
      expectedMint: DEVNET_USDC_MINT,
      expectedAta: PAYEE_ATA,
    });
    expect(parseVendorAtaCliArguments(["--", ...executeArguments])).toEqual(
      parseVendorAtaCliArguments(executeArguments),
    );
    expect(() => parseVendorAtaCliArguments(["--", "--", ...executeArguments])).toThrow(
      /Execution requires exactly/u,
    );
  });

  it("uses read-only preflight by default without loading a signer or sending a transaction", async () => {
    const methods: string[] = [];
    const loadSigner = vi.fn(
      async (_path: string, _policy: KeypairPathPolicy): Promise<TransactionSigner> =>
        fakePayerSigner(),
    );
    const fetchImpl: typeof fetch = async (_input, init) => {
      const request = parseRpcRequest(init);
      methods.push(request.method);
      if (request.method === "getGenesisHash") {
        return rpcResponse(request, DEVNET_GENESIS_HASH);
      }
      if (request.method === "getAccountInfo") {
        return rpcResponse(request, { context: { slot: 100 }, value: null });
      }
      throw new Error(`Unexpected method: ${request.method}`);
    };

    const output = await ensureDevnetVendorUsdcAta(baseInput(false), {
      fetchImpl,
      loadSigner,
    });

    expect(output).toEqual({
      schemaVersion: "1.0",
      evidenceClassification: "infrastructure_setup_not_payment_evidence",
      mode: "preflight",
      status: "ata_missing",
      cluster: "devnet",
      payer: PAYER,
      payee: PAYEE,
      mint: DEVNET_USDC_MINT,
      associatedTokenAccount: PAYEE_ATA,
      transactionCreated: false,
      setupTransactionSignature: null,
      explorerUrl: null,
      setupTransactionFinalized: null,
    });
    expect(loadSigner).not.toHaveBeenCalled();
    expect(methods).toEqual(["getGenesisHash", "getAccountInfo"]);
    expect(methods).not.toContain("sendTransaction");
  });

  it("sends one idempotent ATA-create instruction, waits for finalized, and validates zero-balance postflight", async () => {
    const methods: string[] = [];
    let accountReads = 0;
    let sentInstructionPrograms: readonly string[] = [];
    let sentInstructionData: readonly number[] = [];
    const loadSigner = vi.fn(
      async (_path: string, policy: KeypairPathPolicy): Promise<TransactionSigner> => {
        expect(policy).toEqual({
          allowedRoot: "/ignored/private",
          expectedPublicKey: PAYER,
          requireOwnerOnlyPermissions: true,
        });
        return fakePayerSigner();
      },
    );
    const fetchImpl: typeof fetch = async (_input, init) => {
      const request = parseRpcRequest(init);
      methods.push(request.method);
      if (request.method === "getGenesisHash") {
        return rpcResponse(request, DEVNET_GENESIS_HASH);
      }
      if (request.method === "getAccountInfo") {
        accountReads += 1;
        return rpcResponse(
          request,
          accountReads === 1 ? { context: { slot: 100 }, value: null } : tokenAccount(PAYEE),
        );
      }
      if (request.method === "getLatestBlockhash") {
        return rpcResponse(request, {
          context: { slot: 150 },
          value: { blockhash: BLOCKHASH, lastValidBlockHeight: 300 },
        });
      }
      if (request.method === "sendTransaction") {
        const wire = request.params[0];
        if (typeof wire !== "string") throw new TypeError("Expected encoded transaction");
        const transaction = getTransactionDecoder().decode(Buffer.from(wire, "base64"));
        const message = decompileTransactionMessage(
          getCompiledTransactionMessageDecoder().decode(transaction.messageBytes),
        );
        sentInstructionPrograms = message.instructions.map(
          (instruction) => instruction.programAddress,
        );
        sentInstructionData = [...(message.instructions[0]?.data ?? [])];
        expect(message.instructions).toHaveLength(1);
        expect(message.instructions[0]?.accounts).toHaveLength(6);
        expect(message.instructions[0]?.accounts?.map((meta) => meta.address)).toEqual([
          PAYER,
          PAYEE_ATA,
          PAYEE,
          DEVNET_USDC_MINT,
          "11111111111111111111111111111111",
          TOKEN_PROGRAM_ADDRESS,
        ]);
        return rpcResponse(request, SETUP_SIGNATURE);
      }
      if (request.method === "getSignatureStatuses") {
        return rpcResponse(request, {
          context: { slot: 201 },
          value: [
            {
              slot: 200,
              confirmations: null,
              err: null,
              confirmationStatus: "finalized",
            },
          ],
        });
      }
      throw new Error(`Unexpected method: ${request.method}`);
    };

    const output = await ensureDevnetVendorUsdcAta(baseInput(true), {
      fetchImpl,
      loadSigner,
      pollIntervalMs: 0,
    });

    expect(loadSigner).toHaveBeenCalledTimes(1);
    expect(sentInstructionPrograms).toEqual([ASSOCIATED_TOKEN_PROGRAM_ADDRESS]);
    expect(sentInstructionData).toEqual([1]);
    expect(methods).toEqual([
      "getGenesisHash",
      "getAccountInfo",
      "getLatestBlockhash",
      "sendTransaction",
      "getSignatureStatuses",
      "getAccountInfo",
    ]);
    expect(output).toMatchObject({
      status: "ata_created",
      transactionCreated: true,
      setupTransactionSignature: SETUP_SIGNATURE,
      setupTransactionFinalized: true,
      evidenceClassification: "infrastructure_setup_not_payment_evidence",
    });
    expect(output.explorerUrl).toBe(
      `${"https://explorer.solana.com/tx/"}${SETUP_SIGNATURE}?cluster=devnet`,
    );
  });

  it("rejects wrong RPC, mint, genesis, or execute confirmation before any send", async () => {
    const loadSigner = vi.fn(
      async (_path: string, _policy: KeypairPathPolicy): Promise<TransactionSigner> =>
        fakePayerSigner(),
    );
    const methods: string[] = [];
    const wrongGenesisFetch: typeof fetch = async (_input, init) => {
      const request = parseRpcRequest(init);
      methods.push(request.method);
      return rpcResponse(request, "wrongGenesis111111111111111111111111111111111");
    };

    await expect(
      ensureDevnetVendorUsdcAta({
        ...baseInput(false),
        rpcUrl: "https://rpc.example",
      }, { fetchImpl: wrongGenesisFetch, loadSigner }),
    ).rejects.toThrow(/exactly https:\/\/api\.devnet\.solana\.com/u);
    await expect(
      ensureDevnetVendorUsdcAta({
        ...baseInput(false),
        mint: "11111111111111111111111111111111",
      }, { fetchImpl: wrongGenesisFetch, loadSigner }),
    ).rejects.toThrow(/pinned.*Devnet USDC mint/iu);
    await expect(
      ensureDevnetVendorUsdcAta({
        ...baseInput(true),
        expectedAta: PAYER,
      }, { fetchImpl: wrongGenesisFetch, loadSigner }),
    ).rejects.toThrow(/confirmation must exactly match/iu);
    await expect(
      ensureDevnetVendorUsdcAta(baseInput(false), {
        fetchImpl: wrongGenesisFetch,
        loadSigner,
      }),
    ).rejects.toThrow(/pinned Devnet genesis/iu);

    expect(loadSigner).not.toHaveBeenCalled();
    expect(methods).not.toContain("sendTransaction");
  });
});
