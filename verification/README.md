# $SCRIBE Contract Verification

This directory contains all artifacts needed to verify the deployed $SCRIBE mainnet contracts on [OPScan](https://opscan.org).

## Deployed Contracts (Mainnet)

| Contract | Address | Deployment Tx |
|----------|---------|---------------|
| **ScribeToken** | `0x09676cf6e93d0193ae6a6bfaeb6bcf820afd7d76bbe27c465d69b77471a4dcf2` | [`0a6e8536...`](https://opscan.org/transactions/0a6e8536535226d81a22521d558472fadb6c9ebd49aab2861312690e1afac0d4?network=mainnet) |
| **ScribePresale** | `0xb17f32914c530b7a91b2119bee2164867950dfbbc27221089baef36adefdc226` | [`4b918cff...`](https://opscan.org/transactions/4b918cff43d6528726500f371f6f2fb2e960c28d67381b5420fe6a48afd7ee6b?network=mainnet) |
| **ScribeGovernance** | `0xa96ca19554c91f1171a46f1fbbb4feff4c85225082c89318d921dccb7c39540b` | [`86c52a74...`](https://opscan.org/transactions/86c52a74f58a52a9e581e3bb3b0ff63a6b33c436dc0b15bac02fb93d5841a095?network=mainnet) |
| **ScribeTreasury** | `0xf554238d2b63facd73d9763c5bb67962d1ff19e01dc803444c13b1d963e5e314` | [`43a7b642...`](https://opscan.org/transactions/43a7b6422e4e9c9c1424f4e5ca79133d5f7e153527ba876ae5828e22fe1d9503?network=mainnet) |

Deployed: March 23, 2026

## Local WASM Build Hashes (SHA-256)

These hashes are from a deterministic rebuild using the exact pinned dependencies below.

| Contract | SHA-256 | Size |
|----------|---------|------|
| ScribeToken | `9e85f7428e9e04ca74b08ac905e4e82db89cc28c1f86567a03857d4e4575f999` | 36,442 bytes |
| ScribePresale | `89535ebcd19c0bc7453c76c6508433dde7ab8ff1d07c8ce687772f4c554989dc` | 32,641 bytes |
| ScribeGovernance | `9ea10a01fbf375b77a6044f9a2ad21338ec9b3c0681e076c9e9150fc5b0d06a6` | 26,002 bytes |
| ScribeTreasury | `c32a56014df9a8240b5ca1d8a211be50001c156a46a785fb6641e8532caa3d4b` | 26,732 bytes |

## Build Environment

All contracts were compiled with the following pinned dependencies:

| Package | Version |
|---------|---------|
| `@btc-vision/btc-runtime` | 1.11.0-rc.10 |
| `@btc-vision/as-bignum` | 1.0.0 |
| `@btc-vision/assemblyscript` | 0.29.3 |
| `@btc-vision/opnet-transform` | 1.2.2 |

The `package-lock.json` in this directory pins these exact versions. **Do not run `npm update`** -- use `npm ci` to install the exact locked versions.

## How to Verify

### Independent Verification (rebuild from source)

1. Clone this repo
2. Install exact dependencies:
   ```bash
   cd verification
   npm ci
   ```
3. Build any contract (e.g., ScribePresale):
   ```bash
   npx asc ../contracts/presale/index.ts --config asconfig.json --target presale
   ```
4. Compare the SHA-256 hash of `build/ScribePresale.wasm` against the hashes above

### OPScan Verification

To verify a contract on [OPScan](https://opscan.org):

1. Navigate to the contract page (links in table above)
2. Click "Verify"
3. Upload the following files from this directory:
   - **ABI**: `<ContractName>.abi.json`
   - **Source**: A zip of the `contracts/` directory from the repo root (the source code)
   - **Package Lock**: `package-lock.json`

## Files in This Directory

| File | Purpose |
|------|---------|
| `ScribeToken.abi.json` | Token contract ABI |
| `ScribePresale.abi.json` | Presale contract ABI |
| `ScribeGovernance.abi.json` | Governance contract ABI |
| `ScribeTreasury.abi.json` | Treasury contract ABI |
| `package.json` | Build dependencies |
| `package-lock.json` | Exact pinned dependency versions |
| `asconfig.json` | AssemblyScript compiler configuration |

## Security

- Full audit report available at [`audit/AUDIT_REPORT.md`](../audit/) (coming soon)
- Contract source code is in [`contracts/`](../contracts/)
- 90% of token supply is community-controlled
- Team + dev allocations are vested (1yr/4yr and 3mo/2yr cliffs respectively)
