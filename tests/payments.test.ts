import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FulfillmentReceiptPayloadSchema,
  RecoveryOutcomePayloadSchema,
  canonicalHash,
  sha256Bytes,
} from "@uptime402/domain";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from "@solana/kit";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { decodeTransactionFromPayload } from "@x402/svm";
import bs58 from "bs58";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  DEVNET_CLUSTER_LABEL,
  DEVNET_GENESIS_HASH,
  DEVNET_NETWORK_IDENTITY,
  DEVNET_SVM_SDK_NETWORK_ID,
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  PAYMENT_IDENTIFIER,
  PinnedFacilitatorClient,
  assertSeparateSigningAuthorities,
  attachRequiredPaymentIdentifier,
  buildExactSvmPaymentPayload,
  createPaymentIdentifier,
  decodeStrictPaymentRequiredHeader,
  decodeStrictPaymentResponseHeader,
  decodeStrictPaymentSignatureHeader,
  declareRequiredPaymentIdentifier,
  deriveSolanaCaip2NetworkId,
  encodeStrictPaymentRequiredHeader,
  encodeStrictPaymentResponseHeader,
  encodeStrictPaymentSignatureHeader,
  extractRequiredPaymentIdentifier,
  hashSignedEnvelope,
  inspectExactSvmPaymentTransaction,
  loadCloudRunSecretKeypairSigner,
  loadExistingKeypairSigner,
  sanitizeFacilitatorVerificationFailure,
  signEnvelope,
  runVerifyOnlyFacilitatorDiagnostic,
  safeSolanaSimulationErrorCategory,
  validateExactSvmTransactionBeforeRelease,
  verifyFacilitatorCosignedSvmTransaction,
  verifyEnvelope,
  verifySolanaSettlement,
} from "@uptime402/payments";

function base58Bytes(fill: number, length = 32): string {
  return bs58.encode(Uint8Array.from({ length }, () => fill));
}

const PAYEE = base58Bytes(7);
const PAYER = base58Bytes(8);
const FEE_PAYER = base58Bytes(9);
const RESOURCE_URL = "https://vendor.example/recovery/rpc";

function mutateExactSvmWireBytes(
  paymentPayload: PaymentPayload,
  needle: Uint8Array,
  byteIndex = 0,
  scope: "message" | "wire" = "message",
): PaymentPayload {
  const transactionBase64 = paymentPayload.payload.transaction;
  if (typeof transactionBase64 !== "string") throw new TypeError("missing transaction fixture");
  const transaction = decodeTransactionFromPayload({ transaction: transactionBase64 });
  const wire = Buffer.from(transactionBase64, "base64");
  const haystack = scope === "wire"
    ? wire
    : Buffer.from(Uint8Array.from(transaction.messageBytes));
  const offset = haystack.indexOf(Buffer.from(needle));
  if (offset < 0 || byteIndex < 0 || byteIndex >= needle.byteLength) {
    throw new Error("mutation target is absent from the exact SVM fixture");
  }
  const messageOffset = scope === "wire"
    ? 0
    : wire.indexOf(Buffer.from(Uint8Array.from(transaction.messageBytes)));
  if (messageOffset < 0) throw new Error("transaction message is absent from its wire bytes");
  wire[messageOffset + offset + byteIndex] = wire[messageOffset + offset + byteIndex]! ^ 1;
  return {
    ...structuredClone(paymentPayload),
    payload: { ...paymentPayload.payload, transaction: wire.toString("base64") },
  };
}

function paymentRequired(): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: RESOURCE_URL,
      description: "Paid recovery resource",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: DEVNET_X402_NETWORK_ID,
        asset: DEVNET_USDC_MINT,
        amount: "10000",
        payTo: PAYEE,
        maxTimeoutSeconds: 60,
        extra: {
          feePayer: FEE_PAYER,
          recentBlockhash: base58Bytes(10),
          lastValidBlockHeight: "123456",
        },
      },
    ],
    extensions: {
      [PAYMENT_IDENTIFIER]: declareRequiredPaymentIdentifier(),
    },
  };
}

function paymentPayload(paymentId = createPaymentIdentifier()): PaymentPayload {
  const required = attachRequiredPaymentIdentifier(paymentRequired(), paymentId);
  return {
    x402Version: 2,
    resource: required.resource,
    accepted: required.accepts[0]!,
    payload: { transaction: Buffer.from("signed transaction bytes").toString("base64") },
    ...(required.extensions ? { extensions: required.extensions } : {}),
  };
}

function parsedStandardTokenAccount(owner: string, amountBaseUnits: string) {
  return {
    context: { apiVersion: "2.0.0", slot: 1 },
    value: {
      data: {
        program: "spl-token",
        parsed: {
          type: "account",
          info: {
            mint: DEVNET_USDC_MINT,
            owner,
            state: "initialized",
            tokenAmount: {
              amount: amountBaseUnits,
              decimals: 6,
              uiAmount: null,
              uiAmountString: "redacted-from-authoritative-math",
            },
          },
        },
        space: 165,
      },
      executable: false,
      lamports: 2_039_280,
      owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      rentEpoch: 0,
      space: 165,
    },
  };
}

describe("official Devnet network identity", () => {
  it("keeps cluster, full genesis, derived CAIP-2, SDK value, and mint separate", () => {
    expect(DEVNET_CLUSTER_LABEL).toBe("devnet");
    expect(DEVNET_GENESIS_HASH).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    expect(deriveSolanaCaip2NetworkId(DEVNET_GENESIS_HASH)).toBe(
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    );
    expect(DEVNET_X402_NETWORK_ID).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(DEVNET_SVM_SDK_NETWORK_ID).toBe(DEVNET_X402_NETWORK_ID);
    expect(DEVNET_USDC_MINT).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    expect(DEVNET_NETWORK_IDENTITY).toEqual({
      clusterLabel: DEVNET_CLUSTER_LABEL,
      genesisHash: DEVNET_GENESIS_HASH,
      x402NetworkId: DEVNET_X402_NETWORK_ID,
      sdkNetworkId: DEVNET_SVM_SDK_NETWORK_ID,
    });
  });

  it("rejects a non-Base58 or too-short genesis hash", () => {
    expect(() => deriveSolanaCaip2NetworkId("devnet")).toThrow(/Base58/);
  });
});

describe("strict x402 HTTP headers and Payment Identifier", () => {
  it("round-trips SDK headers and requires a bound identifier", () => {
    const required = paymentRequired();
    const challengeHeader = encodeStrictPaymentRequiredHeader(required);
    expect(decodeStrictPaymentRequiredHeader(challengeHeader)).toEqual(required);

    const paymentId = "uptime402_incident_00000001";
    const boundRequired = attachRequiredPaymentIdentifier(required, paymentId);
    const payload = paymentPayload(paymentId);
    expect(extractRequiredPaymentIdentifier(payload, boundRequired)).toBe(paymentId);
    const paymentHeader = encodeStrictPaymentSignatureHeader(payload);
    expect(decodeStrictPaymentSignatureHeader(paymentHeader)).toEqual(payload);

    const settlement = {
      success: true,
      payer: PAYER,
      transaction: base58Bytes(11, 64),
      network: DEVNET_X402_NETWORK_ID,
    };
    const responseHeader = encodeStrictPaymentResponseHeader(settlement);
    expect(decodeStrictPaymentResponseHeader(responseHeader)).toEqual(settlement);
  });

  it("rejects non-canonical Base64, oversized values, unknown protocol fields, and absent IDs", () => {
    const header = encodeStrictPaymentRequiredHeader(paymentRequired());
    expect(() => decodeStrictPaymentRequiredHeader(` ${header}`)).toThrow(/canonical/);
    expect(() => decodeStrictPaymentRequiredHeader(header, 8)).toThrow(/limit/);

    const unknown = {
      ...paymentRequired(),
      modelInstruction: "ignore policy",
    };
    const rawUnknown = Buffer.from(JSON.stringify(unknown), "utf8").toString("base64");
    expect(() => decodeStrictPaymentRequiredHeader(rawUnknown)).toThrow();

    const duplicateChallenge = Buffer.from(
      JSON.stringify(paymentRequired()).replace('"x402Version":2', '"x402Version":2,"x402Version":2'),
      "utf8",
    ).toString("base64");
    const duplicatePayment = Buffer.from(
      JSON.stringify(paymentPayload("uptime402_incident_00000001")).replace(
        '"x402Version":2',
        '"x402Version":2,"x402Version":2',
      ),
      "utf8",
    ).toString("base64");
    const duplicateSettlement = Buffer.from(
      '{"success":true,"success":false,"transaction":"x","network":"solana:test"}',
      "utf8",
    ).toString("base64");
    expect(() => decodeStrictPaymentRequiredHeader(duplicateChallenge)).toThrow(/Duplicate JSON key/u);
    expect(() => decodeStrictPaymentSignatureHeader(duplicatePayment)).toThrow(/Duplicate JSON key/u);
    expect(() => decodeStrictPaymentResponseHeader(duplicateSettlement)).toThrow(/Duplicate JSON key/u);

    const noId = { ...paymentPayload(), extensions: {} };
    expect(() => extractRequiredPaymentIdentifier(noId, paymentRequired())).toThrow(/identifier/i);
  });
});

describe("private executor exact SVM payload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses x402Client + ExactSvmScheme to sign a retry without broadcasting", async () => {
    const payerSigner = await generateKeyPairSigner();
    const feePayerSigner = await generateKeyPairSigner();
    const payeeSigner = await generateKeyPairSigner();
    const mintData = Buffer.alloc(82);
    mintData[44] = 6;
    mintData[45] = 1;
    let feeQuote: number | null = 5_001;
    const rpcMethods: string[] = [];
    const feeMessageParams: unknown[] = [];
    let tokenAccountReadCount = 0;
    let simulationError: unknown = null;
    let observedGenesisHash: string = DEVNET_GENESIS_HASH;
    const rpcFetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params?: unknown[];
      };
      rpcMethods.push(request.method);
      let result: unknown;
      if (request.method === "getGenesisHash") {
        result = observedGenesisHash;
      } else if (request.method === "getAccountInfo") {
        const config = request.params?.[1] as { encoding?: string } | undefined;
        if (config?.encoding === "jsonParsed") {
          const sourceRead = tokenAccountReadCount % 2 === 0;
          tokenAccountReadCount += 1;
          result = parsedStandardTokenAccount(
            sourceRead ? payerSigner.address : payeeSigner.address,
            sourceRead ? "20000000" : "0",
          );
        } else {
          result = {
            context: { apiVersion: "2.0.0", slot: 1 },
            value: {
              data: [mintData.toString("base64"), "base64"],
              executable: false,
              lamports: 1,
              owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              rentEpoch: 0,
              space: 82,
            },
          };
        }
      } else if (request.method === "getFeeForMessage") {
        feeMessageParams.push(request.params?.[0]);
        result = { context: { apiVersion: "2.0.0", slot: 1 }, value: feeQuote };
      } else if (request.method === "getSlot") {
        result = 123_450;
      } else if (request.method === "getBlockHeight") {
        result = 123_451;
      } else if (request.method === "isBlockhashValid") {
        result = {
          context: { apiVersion: "2.0.0", slot: 123_450 },
          value: true,
        };
      } else if (request.method === "simulateTransaction") {
        result = {
          context: { apiVersion: "2.0.0", slot: 123_450 },
          value: { err: simulationError },
        };
      } else {
        throw new Error(`Unexpected RPC method ${request.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", rpcFetch);

    const paymentId = "uptime402_autosign_000001";
    const required = paymentRequired();
    required.accepts[0]!.payTo = payeeSigner.address;
    required.accepts[0]!.extra = {
      ...required.accepts[0]!.extra,
      feePayer: feePayerSigner.address,
      recentBlockhash: base58Bytes(12),
      memo: paymentId,
    };
    const result = await buildExactSvmPaymentPayload({
      paymentRequired: required,
      paymentId,
      signer: payerSigner,
      rpc: { rpcUrl: "https://rpc.example" },
      expected: {
        amountBaseUnits: "10000",
        payee: payeeSigner.address,
        resourceUrl: RESOURCE_URL,
      },
    });

    expect(result.headerName).toBe("PAYMENT-SIGNATURE");
    expect(result.paymentId).toBe(paymentId);
    expect(result.signedTransactionSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(decodeStrictPaymentSignatureHeader(result.headerValue)).toEqual(result.paymentPayload);
    const inspection = inspectExactSvmPaymentTransaction(result.paymentPayload);
    expect(inspection).toMatchObject({
      payer: payerSigner.address,
      feePayer: feePayerSigner.address,
    });
    expect(inspection.programIds).toHaveLength(3);
    expect(inspection.accountKeys).toEqual(
      expect.arrayContaining([payerSigner.address, feePayerSigner.address, DEVNET_USDC_MINT]),
    );

    const validationOptions = {
      clusterLabel: "devnet",
      genesisHash: DEVNET_GENESIS_HASH,
      network: DEVNET_X402_NETWORK_ID,
      sdkNetworkId: DEVNET_X402_NETWORK_ID,
      assetMint: DEVNET_USDC_MINT,
      assetDecimals: 6,
      amountBaseUnits: "10000",
      payee: payeeSigner.address,
      payer: payerSigner.address,
      feePayer: feePayerSigner.address,
      paymentId,
      allowedProgramIds: inspection.programIds,
      allowedAccountKeys: inspection.accountKeys,
      maxNetworkFeeLamports: "10000",
      configuredNetworkFeeUpperBoundLamports: "10000",
      rpc: { rpcUrl: "https://rpc.example" },
    } as const;
    const decoded = decodeTransactionFromPayload({
      transaction: result.paymentPayload.payload.transaction as string,
    });
    const message = decompileTransactionMessage(
      getCompiledTransactionMessageDecoder().decode(decoded.messageBytes),
    );
    const [computeLimit, computePrice, transfer, memo] = message.instructions;
    const validated = await validateExactSvmTransactionBeforeRelease(
      result.paymentPayload,
      validationOptions,
    );
    expect(validated).toMatchObject({
      payer: payerSigner.address,
      feePayer: feePayerSigner.address,
      mint: DEVNET_USDC_MINT,
      amountBaseUnits: "10000",
      decimals: 6,
      memo: paymentId,
      computeUnitLimit: 20_000,
      computeUnitPriceMicroLamports: "1",
      deterministicPriorityFeeLamports: "1",
      quotedNetworkFeeLamports: "5001",
      feeQuoteSource: "rpc.getFeeForMessage",
      payerSignatureVerified: true,
    });

    const settledTransaction = await partiallySignTransaction(
      [feePayerSigner.keyPair],
      decoded,
    );
    const settledTransactionBase64 = Buffer.from(
      getTransactionEncoder().encode(settledTransaction),
    ).toString("base64");
    await expect(
      verifyFacilitatorCosignedSvmTransaction(
        result.paymentPayload,
        settledTransactionBase64,
      ),
    ).resolves.toMatchObject({
      payer: payerSigner.address,
      feePayer: feePayerSigner.address,
      transactionMessageHash: validated.transactionMessageHash,
      payerSignatureVerified: true,
      facilitatorSignatureVerified: true,
    });
    await expect(
      verifyFacilitatorCosignedSvmTransaction(
        result.paymentPayload,
        result.paymentPayload.payload.transaction as string,
      ),
    ).rejects.toThrow(/lacks the facilitator fee-payer signature/i);

    const settledPayload: PaymentPayload = {
      ...structuredClone(result.paymentPayload),
      payload: { ...result.paymentPayload.payload, transaction: settledTransactionBase64 },
    };
    const mutatedSettledMessage = mutateExactSvmWireBytes(
      settledPayload,
      new TextEncoder().encode(paymentId),
      0,
    ).payload.transaction;
    await expect(
      verifyFacilitatorCosignedSvmTransaction(
        result.paymentPayload,
        mutatedSettledMessage as string,
      ),
    ).rejects.toThrow(/changed the exact SVM transaction message/i);

    const settledPayerSignature = settledTransaction.signatures[payerSigner.address];
    const settledFeePayerSignature = settledTransaction.signatures[feePayerSigner.address];
    if (!settledPayerSignature || !settledFeePayerSignature) {
      throw new Error("settled SVM fixture is missing a required signature");
    }
    const mutatedPayerSignature = mutateExactSvmWireBytes(
      settledPayload,
      Uint8Array.from(settledPayerSignature),
      0,
      "wire",
    ).payload.transaction;
    await expect(
      verifyFacilitatorCosignedSvmTransaction(
        result.paymentPayload,
        mutatedPayerSignature as string,
      ),
    ).rejects.toThrow(/changed the exact SVM payer signature/i);

    const mutatedFacilitatorSignature = mutateExactSvmWireBytes(
      settledPayload,
      Uint8Array.from(settledFeePayerSignature),
      0,
      "wire",
    ).payload.transaction;
    await expect(
      verifyFacilitatorCosignedSvmTransaction(
        result.paymentPayload,
        mutatedFacilitatorSignature as string,
      ),
    ).rejects.toThrow(/facilitator fee-payer signature verification failed/i);

    const exactMessageBase64 = Buffer.from(Uint8Array.from(decoded.messageBytes)).toString("base64");
    expect(feeMessageParams).toEqual([exactMessageBase64]);

    const verifyOnlyInput = {
      rpc: { rpcUrl: "https://rpc.example" },
      paymentPayload: result.paymentPayload,
      paymentRequirements: required.accepts[0]!,
      expectedPayer: payerSigner.address,
      signedTransactionSha256: result.signedTransactionSha256,
      transactionMessageHash: sha256Bytes(
        Uint8Array.from(decoded.messageBytes),
      ),
      signedAt: "2026-08-03T00:00:00.000Z",
      now: () => new Date("2026-08-03T00:00:01.000Z"),
    } as const;
    const verifiedOnly = await runVerifyOnlyFacilitatorDiagnostic({
      ...verifyOnlyInput,
      facilitator: {
        verify: async () => ({ isValid: true, payer: payerSigner.address }),
      },
    });
    expect(verifiedOnly).toMatchObject({
      mode: "verify-only",
      settlementCalled: false,
      classification: "verified",
      facilitator: {
        expectedPayer: payerSigner.address,
        payer: payerSigner.address,
        diagnostic: null,
      },
      sourceSimulation: {
        succeeded: true,
        errorCategory: null,
        diagnosticHash: null,
      },
    });
    const mismatchedPayer = await runVerifyOnlyFacilitatorDiagnostic({
      ...verifyOnlyInput,
      facilitator: {
        verify: async () => ({ isValid: true, payer: payeeSigner.address }),
      },
    });
    simulationError = { InstructionError: [2, { Custom: 1 }] };
    const sourceSimulationFailed = await runVerifyOnlyFacilitatorDiagnostic({
      ...verifyOnlyInput,
      facilitator: {
        verify: async () => ({
          isValid: false,
          payer: payerSigner.address,
          invalidReason: "transaction_simulation_failed",
          invalidMessage: 'Simulation failed: {"InstructionError":[2,{"Custom":1}]}',
        }),
      },
    });
    expect(sourceSimulationFailed).toMatchObject({
      settlementCalled: false,
      classification: "source_simulation_failed",
      sourceSimulation: {
        succeeded: false,
        errorCategory: "InstructionError_2_Custom_1",
      },
      facilitator: {
        diagnostic: { invalidMessage: "InstructionError_2_Custom_1" },
      },
    });
    simulationError = null;
    expect(mismatchedPayer).toMatchObject({
      settlementCalled: false,
      classification: "facilitator_payer_mismatch",
      facilitator: {
        expectedPayer: payerSigner.address,
        payer: payeeSigner.address,
        diagnostic: { invalidReason: "facilitator_payer_mismatch" },
      },
    });

    const semanticMutations = [
      [computeLimit?.data, /compute-unit limit/i],
      [computePrice?.data, /compute-unit price/i],
      [transfer?.data, /TransferChecked/i],
      [memo?.data, /memo/i],
      [bs58.decode(DEVNET_USDC_MINT), /TransferChecked/i],
      [
        transfer?.accounts?.[2]?.address
          ? bs58.decode(transfer.accounts[2].address)
          : undefined,
        /TransferChecked/i,
      ],
      [bs58.decode(payerSigner.address), /TransferChecked|payer/i],
      [bs58.decode(feePayerSigner.address), /fee payer/i],
      [
        transfer?.programAddress ? bs58.decode(transfer.programAddress) : undefined,
        /pinned SPL Token/i,
      ],
    ] as const;
    for (const [needle, pattern] of semanticMutations) {
      if (!needle) throw new Error("exact SVM mutation fixture is missing instruction data");
      await expect(
        validateExactSvmTransactionBeforeRelease(
          mutateExactSvmWireBytes(result.paymentPayload, Uint8Array.from(needle), 1),
          validationOptions,
        ),
      ).rejects.toThrow(pattern);
    }

    const payerSignature = decoded.signatures[payerSigner.address];
    if (!payerSignature) throw new Error("exact SVM fixture is missing its payer signature");
    await expect(
      validateExactSvmTransactionBeforeRelease(
        mutateExactSvmWireBytes(
          result.paymentPayload,
          Uint8Array.from(payerSignature),
          0,
          "wire",
        ),
        validationOptions,
      ),
    ).rejects.toThrow(/signature verification/i);
    feeQuote = 10_001;
    await expect(
      validateExactSvmTransactionBeforeRelease(result.paymentPayload, validationOptions),
    ).rejects.toThrow(/fee quote exceeds/i);
    feeQuote = null;
    await expect(
      validateExactSvmTransactionBeforeRelease(result.paymentPayload, validationOptions),
    ).rejects.toThrow(/could not quote a fee/i);
    observedGenesisHash = base58Bytes(31);
    await expect(
      validateExactSvmTransactionBeforeRelease(result.paymentPayload, validationOptions),
    ).rejects.toThrow(/genesis.*mapping/i);
    expect(rpcMethods.filter((method) => method === "getGenesisHash").length).toBeGreaterThanOrEqual(4);
    expect(tokenAccountReadCount).toBeGreaterThanOrEqual(6);
    expect(rpcMethods).toContain("getAccountInfo");
    expect(rpcMethods).toContain("getFeeForMessage");
    expect(rpcMethods).not.toContain("sendTransaction");
  });

  it.each([
    {
      name: "missing destination ATA",
      sourceAmountBaseUnits: "20000000",
      destinationExists: false,
      error: /destination standard-token ATA does not exist/i,
    },
    {
      name: "insufficient source balance",
      sourceAmountBaseUnits: "9999",
      destinationExists: true,
      error: /source standard-token ATA has insufficient/i,
    },
  ])("rejects $name before invoking the signing SDK", async ({
    sourceAmountBaseUnits,
    destinationExists,
    error,
  }) => {
    const signer = await generateKeyPairSigner();
    const mintData = Buffer.alloc(82);
    mintData[44] = 6;
    mintData[45] = 1;
    let tokenAccountReadCount = 0;
    let sdkMintReads = 0;
    const rpcFetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params?: unknown[];
      };
      let result: unknown;
      if (request.method === "getGenesisHash") {
        result = DEVNET_GENESIS_HASH;
      } else if (request.method === "getAccountInfo") {
        const config = request.params?.[1] as { encoding?: string } | undefined;
        if (config?.encoding === "jsonParsed") {
          const sourceRead = tokenAccountReadCount % 2 === 0;
          tokenAccountReadCount += 1;
          result = sourceRead
            ? parsedStandardTokenAccount(signer.address, sourceAmountBaseUnits)
            : destinationExists
              ? parsedStandardTokenAccount(PAYEE, "0")
              : { context: { apiVersion: "2.0.0", slot: 1 }, value: null };
        } else {
          sdkMintReads += 1;
          result = {
            context: { apiVersion: "2.0.0", slot: 1 },
            value: {
              data: [mintData.toString("base64"), "base64"],
              executable: false,
              lamports: 1,
              owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              rentEpoch: 0,
              space: 82,
            },
          };
        }
      } else {
        throw new Error(`Unexpected RPC method ${request.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", rpcFetch);

    await expect(
      buildExactSvmPaymentPayload({
        paymentRequired: paymentRequired(),
        paymentId: "uptime402_account_preflight_0001",
        signer,
        rpc: { rpcUrl: "https://rpc.example" },
        expected: {
          amountBaseUnits: "10000",
          payee: PAYEE,
          resourceUrl: RESOURCE_URL,
        },
      }),
    ).rejects.toThrow(error);
    expect(tokenAccountReadCount).toBe(2);
    expect(sdkMintReads).toBe(0);
  });

  it("rechecks the destination ATA after signing and before returning the payload", async () => {
    const signer = await generateKeyPairSigner();
    const mintData = Buffer.alloc(82);
    mintData[44] = 6;
    mintData[45] = 1;
    let tokenAccountReadCount = 0;
    let destinationReadCount = 0;
    let sdkMintReads = 0;
    const rpcFetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params?: unknown[];
      };
      let result: unknown;
      if (request.method === "getGenesisHash") {
        result = DEVNET_GENESIS_HASH;
      } else if (request.method === "getAccountInfo") {
        const config = request.params?.[1] as { encoding?: string } | undefined;
        if (config?.encoding === "jsonParsed") {
          const sourceRead = tokenAccountReadCount % 2 === 0;
          tokenAccountReadCount += 1;
          if (sourceRead) {
            result = parsedStandardTokenAccount(signer.address, "20000000");
          } else {
            destinationReadCount += 1;
            result = destinationReadCount === 1
              ? parsedStandardTokenAccount(PAYEE, "0")
              : { context: { apiVersion: "2.0.0", slot: 1 }, value: null };
          }
        } else {
          sdkMintReads += 1;
          result = {
            context: { apiVersion: "2.0.0", slot: 1 },
            value: {
              data: [mintData.toString("base64"), "base64"],
              executable: false,
              lamports: 1,
              owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              rentEpoch: 0,
              space: 82,
            },
          };
        }
      } else {
        throw new Error(`Unexpected RPC method ${request.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", rpcFetch);

    await expect(
      buildExactSvmPaymentPayload({
        paymentRequired: paymentRequired(),
        paymentId: "uptime402_account_postflight_0001",
        signer,
        rpc: { rpcUrl: "https://rpc.example" },
        expected: {
          amountBaseUnits: "10000",
          payee: PAYEE,
          resourceUrl: RESOURCE_URL,
        },
      }),
    ).rejects.toThrow(/destination standard-token ATA does not exist/i);
    expect(tokenAccountReadCount).toBe(4);
    expect(destinationReadCount).toBe(2);
    expect(sdkMintReads).toBe(1);
  });

  it("rejects a challenge that changes the authorized amount before signing", async () => {
    const signer = await generateKeyPairSigner();
    await expect(
      buildExactSvmPaymentPayload({
        paymentRequired: paymentRequired(),
        paymentId: "uptime402_denied_0000001",
        signer,
        rpc: { rpcUrl: "https://rpc.example" },
        expected: { amountBaseUnits: "10001", payee: PAYEE, resourceUrl: RESOURCE_URL },
      }),
    ).rejects.toThrow(/exactly one authorized/);
  });
});

describe("existing keypair path loader", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "uptime402-key-test-"));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  async function keypairFixture(): Promise<{ bytes: number[]; address: string }> {
    const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed, true);
    const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", signer.keyPair.publicKey));
    return { bytes: [...seed, ...publicBytes], address: signer.address };
  }

  it("loads a 0600 regular file and returns only a non-extractable signer", async () => {
    const fixture = await keypairFixture();
    const path = join(directory, "executor.json");
    await writeFile(path, JSON.stringify(fixture.bytes), { mode: 0o600 });
    const signer = await loadExistingKeypairSigner(path, {
      allowedRoot: directory,
      expectedPublicKey: fixture.address,
    });
    expect(signer.address).toBe(fixture.address);
    expect(signer.keyPair.privateKey.extractable).toBe(false);
  });

  it("rejects permissive files, symlink traversal, and a mismatched public key", async () => {
    const fixture = await keypairFixture();
    const path = join(directory, "executor.json");
    await writeFile(path, JSON.stringify(fixture.bytes), { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(loadExistingKeypairSigner(path)).rejects.toThrow(/permissions/);
    await chmod(path, 0o600);
    await expect(
      loadExistingKeypairSigner(path, { expectedPublicKey: base58Bytes(77) }),
    ).rejects.toThrow(/pinned public key/);
    const linked = join(directory, "linked.json");
    await symlink(path, linked);
    await expect(loadExistingKeypairSigner(linked)).rejects.toThrow(/symbolic link/);
  });

  it("loads Cloud Run read-only in-root secret symlinks without weakening the local loader", async () => {
    const fixture = await keypairFixture();
    const versions = join(directory, "versions");
    await mkdir(versions);
    const target = join(versions, "1");
    await writeFile(target, JSON.stringify(fixture.bytes), { mode: 0o400 });
    await chmod(target, 0o444);
    const mounted = join(directory, "executor.json");
    await symlink(target, mounted);
    const signer = await loadCloudRunSecretKeypairSigner(mounted, {
      allowedRoot: directory,
      expectedPublicKey: fixture.address,
    });
    expect(signer.address).toBe(fixture.address);
    await expect(loadExistingKeypairSigner(mounted)).rejects.toThrow(/symbolic link/);
  });

  it("rejects Cloud Run secret links outside the mount root and writable targets", async () => {
    const fixture = await keypairFixture();
    const outside = await mkdtemp(join(tmpdir(), "uptime402-outside-key-test-"));
    try {
      const outsideTarget = join(outside, "key.json");
      await writeFile(outsideTarget, JSON.stringify(fixture.bytes), { mode: 0o400 });
      const escaped = join(directory, "escaped.json");
      await symlink(outsideTarget, escaped);
      await expect(
        loadCloudRunSecretKeypairSigner(escaped, {
          allowedRoot: directory,
          expectedPublicKey: fixture.address,
        }),
      ).rejects.toThrow(/outside/);

      const writable = join(directory, "writable.json");
      await writeFile(writable, JSON.stringify(fixture.bytes), { mode: 0o600 });
      await chmod(writable, 0o622);
      await expect(
        loadCloudRunSecretKeypairSigner(writable, {
          allowedRoot: directory,
          expectedPublicKey: fixture.address,
        }),
      ).rejects.toThrow(/writable/);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

describe("RFC 8785 Ed25519 signed envelopes", () => {
  const hash = (fill: string) => `sha256:${fill.repeat(64).slice(0, 64)}`;

  it("binds every fulfillment field and rejects field mutation", async () => {
    const vendor = await generateKeyPairSigner();
    const payload = FulfillmentReceiptPayloadSchema.parse({
      version: "1",
      issuerAgentId: "vendor-agent",
      incidentId: "incident-1",
      offerId: "offer-fast",
      paymentId: "uptime402_payment_000001",
      executionPolicyHash: hash("a"),
      challengeHash: hash("b"),
      requestFingerprint: hash("c"),
      txSignature: base58Bytes(13, 64),
      resourceResponseHash: hash("d"),
      resourceUrl: RESOURCE_URL,
      payer: PAYER,
      payee: PAYEE,
      assetMint: DEVNET_USDC_MINT,
      amountBaseUnits: "10000",
      fulfilledAt: "2026-08-03T10:00:00+09:00",
    });
    const envelope = await signEnvelope(payload, FulfillmentReceiptPayloadSchema, {
      keyId: "did:web:vendor.example#receipt-1",
      signer: vendor,
    });
    await expect(
      verifyEnvelope(envelope, {
        payloadSchema: FulfillmentReceiptPayloadSchema,
        expectedSigner: vendor.address,
        expectedKeyId: "did:web:vendor.example#receipt-1",
        forbiddenSigner: PAYEE,
      }),
    ).resolves.toEqual(envelope);
    expect(hashSignedEnvelope(envelope)).toBe(canonicalHash(envelope));

    const mutations: Record<string, unknown> = {
      version: "2",
      issuerAgentId: "vendor-agent-mutated",
      incidentId: "incident-2",
      offerId: "offer-economy",
      paymentId: "uptime402_payment_000002",
      executionPolicyHash: hash("e"),
      challengeHash: hash("f"),
      requestFingerprint: hash("1"),
      txSignature: base58Bytes(14, 64),
      resourceResponseHash: hash("2"),
      resourceUrl: "https://vendor.example/recovery/other",
      payer: base58Bytes(15),
      payee: base58Bytes(16),
      assetMint: base58Bytes(17),
      amountBaseUnits: "10001",
      fulfilledAt: "2026-08-03T10:00:01+09:00",
    };
    for (const [field, value] of Object.entries(mutations)) {
      const mutated = {
        ...envelope,
        payload: { ...envelope.payload, [field]: value },
      };
      await expect(
        verifyEnvelope(mutated, {
          payloadSchema: FulfillmentReceiptPayloadSchema,
          expectedSigner: vendor.address,
          expectedKeyId: envelope.keyId,
        }),
        `mutation of ${field}`,
      ).rejects.toThrow();
    }
  });

  it("requires distinct vendor, outcome, and payee identities", async () => {
    const vendor = await generateKeyPairSigner();
    const outcomeSigner = await generateKeyPairSigner();
    const outcome = await signEnvelope(
      {
        incidentId: "incident-1",
        paymentId: "uptime402_payment_000001",
        fulfillmentReceiptHash: hash("a"),
        resourceResponseHash: hash("b"),
        statusBefore: "down" as const,
        statusAfter: "healthy" as const,
        healthProbeHash: hash("c"),
        recoveredAt: "2026-08-03T10:00:02+09:00",
      },
      RecoveryOutcomePayloadSchema,
      { keyId: "outcome-key-1", signer: outcomeSigner },
    );
    const vendorIdentity = { signer: vendor.address, keyId: "vendor-key-1" };
    expect(() => assertSeparateSigningAuthorities(vendorIdentity, outcome, PAYEE)).not.toThrow();
    expect(() => assertSeparateSigningAuthorities(outcome, outcome, PAYEE)).toThrow(/separate/);
    await expect(
      verifyEnvelope(outcome, {
        payloadSchema: RecoveryOutcomePayloadSchema,
        expectedSigner: vendor.address,
        expectedKeyId: outcome.keyId,
      }),
    ).rejects.toThrow(/pinned/);
  });
});

describe("pinned facilitator client", () => {
  it("emits only allowlisted verification diagnostics and never reflects raw messages", () => {
    const blockhashFailure = sanitizeFacilitatorVerificationFailure({
      isValid: false,
      invalidReason: "transaction_simulation_failed",
      invalidMessage:
        'Simulation failed: "BlockhashNotFound" PAYMENT-SIGNATURE=secret-payload-token',
    });
    expect(blockhashFailure).toMatchObject({
      invalidReason: "transaction_simulation_failed",
      invalidMessage: "BlockhashNotFound",
    });
    expect(blockhashFailure.diagnosticHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(blockhashFailure)).not.toContain("secret-payload-token");

    const customInstructionFailure = sanitizeFacilitatorVerificationFailure({
      isValid: false,
      invalidReason: "transaction_simulation_failed",
      invalidMessage:
        'Simulation failed: {"InstructionError":[2,{"Custom":1}]}',
    });
    expect(customInstructionFailure.invalidMessage).toBe(
      "InstructionError_2_Custom_1",
    );
    expect(
      safeSolanaSimulationErrorCategory({
        InstructionError: [3, "InvalidAccountData"],
      }),
    ).toBe("InstructionError_3_InvalidAccountData");
    expect(
      safeSolanaSimulationErrorCategory({
        InstructionError: ["3", "ProgramFailedToComplete"],
      }),
    ).toBe("InstructionError_3_ProgramFailedToComplete");
    expect(
      safeSolanaSimulationErrorCategory({ attacker: "Bearer raw-secret" }),
    ).toBe("redacted_unrecognized_simulation_error");

    const unknown = sanitizeFacilitatorVerificationFailure({
      isValid: false,
      invalidReason: "private-key-is-this-value",
      invalidMessage: "Bearer credential-value",
    });
    expect(unknown).toMatchObject({
      invalidReason: "unrecognized_facilitator_reason",
      invalidMessage: "redacted_unrecognized_facilitator_message",
    });
    expect(JSON.stringify(unknown)).not.toContain("credential-value");
    expect(() => sanitizeFacilitatorVerificationFailure({ isValid: true })).toThrow(/not a verification failure/u);
  });

  it("uses fixed HTTPS endpoints, no redirects, timeouts, and strict response schemas", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const endpoint = new URL(String(input)).pathname;
      const body = endpoint === "/supported"
        ? { kinds: [{ x402Version: 2, scheme: "exact", network: DEVNET_X402_NETWORK_ID }], extensions: [PAYMENT_IDENTIFIER], signers: { [DEVNET_X402_NETWORK_ID]: [FEE_PAYER] } }
        : endpoint === "/verify"
          ? { isValid: true, payer: PAYER }
          : { success: true, payer: PAYER, transaction: base58Bytes(18, 64), network: DEVNET_X402_NETWORK_ID };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }) as typeof fetch;
    const client = new PinnedFacilitatorClient({
      baseUrl: "https://facilitator.example/",
      pinnedOrigin: "https://facilitator.example",
      fetchImpl,
      timeoutMs: 500,
    });
    await expect(client.getSupported()).resolves.toMatchObject({ kinds: [{ scheme: "exact" }] });
    const payload = paymentPayload();
    await expect(client.verify(payload, payload.accepted)).resolves.toEqual({ isValid: true, payer: PAYER });
    await expect(client.settle(payload, payload.accepted)).resolves.toMatchObject({ success: true });
    expect(calls.map((call) => call.url)).toEqual([
      "https://facilitator.example/supported",
      "https://facilitator.example/verify",
      "https://facilitator.example/settle",
    ]);
    expect(calls.every((call) => call.init?.redirect === "error")).toBe(true);
    expect(calls.every((call) => call.init?.signal instanceof AbortSignal)).toBe(true);
  });

  it("normalizes a facilitator base path without requiring a trailing slash", async () => {
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo) =>
      new Response(JSON.stringify({ kinds: [], extensions: [], signers: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const client = new PinnedFacilitatorClient({
      baseUrl: "https://x402.org/facilitator",
      pinnedOrigin: "https://x402.org",
      fetchImpl,
    });
    await client.getSupported();
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://x402.org/facilitator/supported"),
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("rejects unsafe origins, wrong content type, and oversized responses", async () => {
    expect(() => new PinnedFacilitatorClient({ baseUrl: "http://facilitator.example" })).toThrow(/HTTPS/);
    expect(() => new PinnedFacilitatorClient({ baseUrl: "https://127.0.0.1/" })).toThrow(/private/);
    expect(() => new PinnedFacilitatorClient({
      baseUrl: "https://facilitator.example/",
      pinnedOrigin: "https://other.example",
    })).toThrow(/pinned/);

    const wrongType = new PinnedFacilitatorClient({
      baseUrl: "https://facilitator.example/",
      fetchImpl: (async () => new Response("{}", { headers: { "content-type": "text/plain" } })) as typeof fetch,
    });
    await expect(wrongType.getSupported()).rejects.toThrow(/content type/);

    const oversized = new PinnedFacilitatorClient({
      baseUrl: "https://facilitator.example/",
      maxResponseBytes: 10,
      fetchImpl: (async () => new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "11" },
      })) as typeof fetch,
    });
    await expect(oversized.getSupported()).rejects.toThrow(/body limit/);
  });

  it("rejects duplicate facilitator response keys before strict schema normalization", async () => {
    const client = new PinnedFacilitatorClient({
      baseUrl: "https://facilitator.example/",
      fetchImpl: (async () =>
        new Response(
          '{"kinds":[],"extensions":[],"signers":{},"signers":{"devnet":[]}}',
          { headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    await expect(client.getSupported()).rejects.toThrow(/Duplicate JSON key/u);
  });
});

describe("independent Solana RPC settlement verifier", () => {
  const txSignature = base58Bytes(19, 64);
  const payerToken = base58Bytes(20);
  const payeeToken = base58Bytes(21);

  function settlementFetch(payeePostAmount = "10100"): typeof fetch {
    return vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      let result: unknown;
      if (request.method === "getGenesisHash") {
        result = DEVNET_GENESIS_HASH;
      } else if (request.method === "getSignatureStatuses") {
        result = {
          context: { slot: 123 },
          value: [{ slot: 123, confirmations: 2, err: null, confirmationStatus: "confirmed" }],
        };
      } else if (request.method === "getTransaction") {
        result = {
          slot: 123,
          blockTime: 1_786_000_000,
          meta: {
            err: null,
            preTokenBalances: [
              { accountIndex: 0, mint: DEVNET_USDC_MINT, owner: PAYER, uiTokenAmount: { amount: "50000", decimals: 6 } },
              { accountIndex: 1, mint: DEVNET_USDC_MINT, owner: PAYEE, uiTokenAmount: { amount: "100", decimals: 6 } },
            ],
            postTokenBalances: [
              { accountIndex: 0, mint: DEVNET_USDC_MINT, owner: PAYER, uiTokenAmount: { amount: "40000", decimals: 6 } },
              { accountIndex: 1, mint: DEVNET_USDC_MINT, owner: PAYEE, uiTokenAmount: { amount: payeePostAmount, decimals: 6 } },
            ],
          },
          transaction: {
            signatures: [txSignature],
            message: { accountKeys: [payerToken, payeeToken] },
          },
        };
      } else {
        throw new Error(`Unexpected RPC method ${request.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  it("proves genesis, confirmation, mint, distinct owners, exact negative/positive deltas, and Explorer URL", async () => {
    const result = await verifySolanaSettlement({
      rpc: { rpcUrl: "https://rpc.example", fetchImpl: settlementFetch() },
      txSignature,
      payerOwner: PAYER,
      payeeOwner: PAYEE,
      amountBaseUnits: "10000",
    });
    expect(result).toMatchObject({
      verification: "verified",
      genesisHash: DEVNET_GENESIS_HASH,
      network: DEVNET_X402_NETWORK_ID,
      assetMint: DEVNET_USDC_MINT,
      confirmationStatus: "confirmed",
      payerDeltaBaseUnits: "-10000",
      payeeDeltaBaseUnits: "10000",
      explorerUrl: `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`,
    });
    expect(result.tokenAccountDeltas).toEqual([
      expect.objectContaining({ tokenAccount: payerToken, owner: PAYER, deltaBaseUnits: "-10000" }),
      expect.objectContaining({ tokenAccount: payeeToken, owner: PAYEE, deltaBaseUnits: "10000" }),
    ]);
  });

  it("rejects owner reuse and a mismatched positive balance delta", async () => {
    await expect(
      verifySolanaSettlement({
        rpc: { rpcUrl: "https://rpc.example", fetchImpl: settlementFetch() },
        txSignature,
        payerOwner: PAYER,
        payeeOwner: PAYER,
        amountBaseUnits: "10000",
      }),
    ).rejects.toThrow(/distinct/);
    await expect(
      verifySolanaSettlement({
        rpc: { rpcUrl: "https://rpc.example", fetchImpl: settlementFetch("10099") },
        txSignature,
        payerOwner: PAYER,
        payeeOwner: PAYEE,
        amountBaseUnits: "10000",
      }),
    ).rejects.toThrow(/deltas/);
  });
});
