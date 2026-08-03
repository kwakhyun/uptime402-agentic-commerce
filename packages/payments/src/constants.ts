import {
  SOLANA_DEVNET_CAIP2,
  USDC_DEVNET_ADDRESS,
} from "@x402/svm";

export const DEVNET_CLUSTER_LABEL = "devnet" as const;
export const DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" as const;
export const DEVNET_X402_NETWORK_ID =
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
export const DEVNET_USDC_MINT =
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as const;
export const USDC_DECIMALS = 6 as const;

/**
 * @x402/svm v2.20.0 accepts a CAIP-2 network string as its SDK network value.
 * This field deliberately remains separate from the wire identifier so a future
 * SDK enum change cannot silently alter protocol evidence.
 */
export const DEVNET_SVM_SDK_NETWORK_ID = SOLANA_DEVNET_CAIP2;
export const SVM_V2_REGISTRATION_PATTERN = "solana:*" as const;

export type ClusterLabel = typeof DEVNET_CLUSTER_LABEL;
export type X402NetworkId = typeof DEVNET_X402_NETWORK_ID;
export type SvmSdkNetworkId = typeof DEVNET_SVM_SDK_NETWORK_ID;

export type DevnetNetworkIdentity = Readonly<{
  clusterLabel: ClusterLabel;
  genesisHash: typeof DEVNET_GENESIS_HASH;
  x402NetworkId: X402NetworkId;
  sdkNetworkId: SvmSdkNetworkId;
}>;

export function deriveSolanaCaip2NetworkId(genesisHash: string): `solana:${string}` {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(genesisHash)) {
    throw new TypeError("Solana genesis hash must be a Base58 string of at least 32 characters");
  }
  return `solana:${genesisHash.slice(0, 32)}`;
}

function assertInstalledSdkConstants(): void {
  if (SOLANA_DEVNET_CAIP2 !== DEVNET_X402_NETWORK_ID) {
    throw new Error("Installed @x402/svm Devnet CAIP-2 constant does not match the pinned mapping");
  }
  if (USDC_DEVNET_ADDRESS !== DEVNET_USDC_MINT) {
    throw new Error("Installed @x402/svm Devnet USDC mint does not match the pinned mint");
  }
  if (deriveSolanaCaip2NetworkId(DEVNET_GENESIS_HASH) !== DEVNET_X402_NETWORK_ID) {
    throw new Error("Pinned Devnet genesis hash does not derive the pinned CAIP-2 network");
  }
}

assertInstalledSdkConstants();

export const DEVNET_NETWORK_IDENTITY: DevnetNetworkIdentity = Object.freeze({
  clusterLabel: DEVNET_CLUSTER_LABEL,
  genesisHash: DEVNET_GENESIS_HASH,
  x402NetworkId: DEVNET_X402_NETWORK_ID,
  sdkNetworkId: DEVNET_SVM_SDK_NETWORK_ID,
});
