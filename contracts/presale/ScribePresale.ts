import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    AddressMemoryMap,
    Blockchain,
    BytesWriter,
    Calldata,
    encodeSelector,
    OP_NET,
    Revert,
    SafeMath,
    StoredAddress,
    StoredBoolean,
    StoredU256,
    TransferHelper,
} from '@btc-vision/btc-runtime/runtime';
import { StoredString } from '@btc-vision/btc-runtime/runtime/storage/StoredString';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';

// 2.1B tokens * 10^2 decimals = 210,000,000,000 internal units
const PRESALE_SUPPLY: u256 = u256.fromString('210000000000');

// Prices in sats per whole token, scaled by 10^8
const START_PRICE: u256 = u256.fromU64(15000000);   // 0.15 * 10^8
const PRICE_RANGE: u256 = u256.fromU64(150000000);   // (1.65 - 0.15) * 10^8

// Conversion: 10^decimals * 10^priceScale = 10^2 * 10^8 = 10^10
const CONVERSION: u256 = u256.fromU64(10000000000);

// Two — used in integral formula
const TWO: u256 = u256.fromU64(2);

// Max contribution per wallet: 1 BTC = 100,000,000 sats
const MAX_CONTRIBUTION: u256 = u256.fromU64(100000000);

// Vesting: 30 days in blocks (~144 blocks/day * 30 = 4320)
const VESTING_BLOCKS: u256 = u256.fromU32(4320);

// Governance Reserve: 2.1B tokens (10% of supply) — burn or LM, decided by presale vote
const RESERVE_AMOUNT: u256 = u256.fromString('210000000000');

// Vote choices
const VOTE_BURN: u256 = u256.One;
const VOTE_LM: u256 = u256.fromU64(2);

// Integer square root for u256 using bit-by-bit method
// Max 128 iterations (bit positions 254, 252, ..., 2, 0)
function u256sqrt(value: u256): u256 {
    if (value < TWO) return value;

    let rem: u256 = value;
    let res: u256 = u256.Zero;

    // Find highest set bit pair position
    const bits: i32 = 255 - u256.clz(value);
    const startBit: i32 = bits & ~1; // round down to even

    // Iterate from startBit down to 0 in steps of 2 (max 128 iterations)
    for (let b: i32 = startBit; b >= 0; b -= 2) {
        const pos: u256 = SafeMath.shl(u256.One, b);
        const test: u256 = SafeMath.add(res, pos);
        if (rem >= test) {
            rem = SafeMath.sub(rem, test);
            res = SafeMath.add(pos, test);
        }
        res = SafeMath.shr(res, 1);
    }

    return res;
}

@final
export class ScribePresale extends OP_NET {
    private readonly tokenAddrPointer: u16 = Blockchain.nextPointer;
    private readonly tokenAddr: StoredAddress = new StoredAddress(this.tokenAddrPointer);

    private readonly treasuryAddrPointer: u16 = Blockchain.nextPointer;
    private readonly treasuryAddr: StoredAddress = new StoredAddress(this.treasuryAddrPointer);

    private readonly lpAddrPointer: u16 = Blockchain.nextPointer;
    private readonly lpAddr: StoredAddress = new StoredAddress(this.lpAddrPointer);

    // Collection address P2TR tweaked pubkey (32 bytes stored as u256)
    // This is NOT an Address (ML-DSA hash) — it's the raw bech32m witness program
    private readonly collectionKeyPointer: u16 = Blockchain.nextPointer;
    private readonly _collectionKey: StoredU256 = new StoredU256(this.collectionKeyPointer, EMPTY_POINTER);

    // Collection address as bech32m string (for matching output.to in simulation)
    private readonly collectionStrPointer: u16 = Blockchain.nextPointer;
    private readonly _collectionStr: StoredString = new StoredString(this.collectionStrPointer);

    private readonly totalSoldPointer: u16 = Blockchain.nextPointer;
    private readonly _totalSold: StoredU256 = new StoredU256(this.totalSoldPointer, EMPTY_POINTER);

    private readonly totalBtcPointer: u16 = Blockchain.nextPointer;
    private readonly _totalBtc: StoredU256 = new StoredU256(this.totalBtcPointer, EMPTY_POINTER);

    private readonly isActivePointer: u16 = Blockchain.nextPointer;
    private readonly _isActive: StoredBoolean = new StoredBoolean(this.isActivePointer, false);

    private readonly isEndedPointer: u16 = Blockchain.nextPointer;
    private readonly _isEnded: StoredBoolean = new StoredBoolean(this.isEndedPointer, false);

    // Buyer tracking
    private readonly buyerTokensPointer: u16 = Blockchain.nextPointer;
    private readonly buyerTokensMap: AddressMemoryMap = new AddressMemoryMap(this.buyerTokensPointer);

    private readonly buyerBtcPointer: u16 = Blockchain.nextPointer;
    private readonly buyerBtcMap: AddressMemoryMap = new AddressMemoryMap(this.buyerBtcPointer);

    // Per-wallet BTC contribution cap tracking
    private readonly contributionPointer: u16 = Blockchain.nextPointer;
    private readonly contributionMap: AddressMemoryMap = new AddressMemoryMap(this.contributionPointer);

    // Max contribution (admin-adjustable)
    private readonly maxContribPointer: u16 = Blockchain.nextPointer;
    private readonly _maxContrib: StoredU256 = new StoredU256(this.maxContribPointer, EMPTY_POINTER);

    // Vote power accumulators (additive only)
    private readonly burnVotePowerPointer: u16 = Blockchain.nextPointer;
    private readonly _burnVotePower: StoredU256 = new StoredU256(this.burnVotePowerPointer, EMPTY_POINTER);

    private readonly lmVotePowerPointer: u16 = Blockchain.nextPointer;
    private readonly _lmVotePower: StoredU256 = new StoredU256(this.lmVotePowerPointer, EMPTY_POINTER);

    private readonly abstainPowerPointer: u16 = Blockchain.nextPointer;
    private readonly _abstainPower: StoredU256 = new StoredU256(this.abstainPowerPointer, EMPTY_POINTER);

    // Vote event counters
    private readonly burnEventCountPointer: u16 = Blockchain.nextPointer;
    private readonly _burnEventCount: StoredU256 = new StoredU256(this.burnEventCountPointer, EMPTY_POINTER);

    private readonly lmEventCountPointer: u16 = Blockchain.nextPointer;
    private readonly _lmEventCount: StoredU256 = new StoredU256(this.lmEventCountPointer, EMPTY_POINTER);

    private readonly abstainEventCountPointer: u16 = Blockchain.nextPointer;
    private readonly _abstainEventCount: StoredU256 = new StoredU256(this.abstainEventCountPointer, EMPTY_POINTER);

    // ── Vesting (built-in, trustless) ──
    private readonly vestingStartBlockPointer: u16 = Blockchain.nextPointer;
    private readonly _vestingStartBlock: StoredU256 = new StoredU256(this.vestingStartBlockPointer, EMPTY_POINTER);

    private readonly vestingStartedPointer: u16 = Blockchain.nextPointer;
    private readonly _vestingStarted: StoredBoolean = new StoredBoolean(this.vestingStartedPointer, false);

    private readonly claimedPointer: u16 = Blockchain.nextPointer;
    private readonly claimedMap: AddressMemoryMap = new AddressMemoryMap(this.claimedPointer);

    // ── Governance Reserve (burn or LM, decided by presale vote) ──
    private readonly reserveBurnExecutedPointer: u16 = Blockchain.nextPointer;
    private readonly _reserveBurnExecuted: StoredBoolean = new StoredBoolean(this.reserveBurnExecutedPointer, false);

    private readonly reserveLmExecutedPointer: u16 = Blockchain.nextPointer;
    private readonly _reserveLmExecuted: StoredBoolean = new StoredBoolean(this.reserveLmExecutedPointer, false);

    public constructor() {
        super();
    }

    public override onDeployment(_calldata: Calldata): void {
        // Set default max contribution to 1 BTC
        this._maxContrib.value = MAX_CONTRIBUTION;
    }

    @method(
        { name: 'token', type: ABIDataTypes.ADDRESS },
        { name: 'treasury', type: ABIDataTypes.ADDRESS },
        { name: 'lp', type: ABIDataTypes.ADDRESS },
        { name: 'collectionTweakedKey', type: ABIDataTypes.UINT256 },
        { name: 'collectionAddress', type: ABIDataTypes.STRING },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public configure(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this.tokenAddr.value = calldata.readAddress();
        this.treasuryAddr.value = calldata.readAddress();
        this.lpAddr.value = calldata.readAddress();
        this._collectionKey.value = calldata.readU256();
        this._collectionStr.value = calldata.readStringWithLength();
        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setMaxContribution(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this._maxContrib.value = calldata.readU256();
        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    @method()
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public start(_calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        if (this._isActive.value) throw new Revert('Already active');
        if (this._isEnded.value) throw new Revert('Already ended');
        this._isActive.value = true;
        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    @method()
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public end(_calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        if (!this._isActive.value) throw new Revert('Not active');
        this._isActive.value = false;
        this._isEnded.value = true;
        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    /**
     * Buy tokens using INTEGRAL bonding curve pricing.
     * BTC payment is verified from transaction outputs — the buyer must include
     * an output to the collection address in the same transaction.
     *
     * Price function: P(x) = START_PRICE + PRICE_RANGE * x / PRESALE_SUPPLY
     * Cost to buy t tokens starting from position sold:
     *   cost = P(sold)*t + PRICE_RANGE * t^2 / (2 * PRESALE_SUPPLY)
     *
     * Given satsIn (verified from outputs), solve for t:
     *   t = (-S*P0 + sqrt(S^2*P0^2 + 2*PRICE_RANGE*S*satsIn*CONVERSION)) / PRICE_RANGE
     */
    @method(
        { name: 'vote', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'tokensReceived', type: ABIDataTypes.UINT256 })
    public buy(calldata: Calldata): BytesWriter {
        if (!this._isActive.value) throw new Revert('Presale not active');

        const voteChoice: u256 = calldata.readU256();
        if (voteChoice > VOTE_LM) throw new Revert('Invalid vote');

        // Verify BTC payment from transaction outputs
        const btcAmount: u256 = this.verifyPaymentToCollection();
        if (btcAmount.isZero()) throw new Revert('No BTC payment to collection address');

        // Check per-wallet contribution cap
        const buyer: Address = Blockchain.tx.sender;
        const prevContrib: u256 = this.contributionMap.get(buyer);
        const newContrib: u256 = SafeMath.add(prevContrib, btcAmount);
        const maxCap: u256 = this._maxContrib.value;
        if (!maxCap.isZero() && newContrib > maxCap) throw new Revert('Exceeds per-wallet cap');

        // Compute current price at sold position
        const sold: u256 = this._totalSold.value;
        const P0: u256 = SafeMath.add(
            START_PRICE,
            SafeMath.div(SafeMath.mul(PRICE_RANGE, sold), PRESALE_SUPPLY),
        );

        // Integral formula:
        // t = (-S*P0 + sqrt(S^2*P0^2 + 2*PRICE_RANGE*S*satsIn*CONVERSION)) / PRICE_RANGE
        const A: u256 = SafeMath.mul(PRESALE_SUPPLY, P0);
        const B: u256 = SafeMath.mul(
            SafeMath.mul(TWO, PRICE_RANGE),
            SafeMath.mul(
                SafeMath.mul(PRESALE_SUPPLY, btcAmount),
                CONVERSION,
            ),
        );

        const A_squared: u256 = SafeMath.mul(A, A);
        const disc: u256 = SafeMath.add(A_squared, B);
        const sqrtDisc: u256 = u256sqrt(disc);

        // sqrtDisc must be > A for positive tokens
        if (sqrtDisc <= A) throw new Revert('Math error');

        const tokensOut: u256 = SafeMath.div(
            SafeMath.sub(sqrtDisc, A),
            PRICE_RANGE,
        );

        if (tokensOut.isZero()) throw new Revert('Amount too small');

        // Cap at remaining supply
        const remaining: u256 = SafeMath.sub(PRESALE_SUPPLY, sold);
        const actualTokens: u256 = tokensOut > remaining ? remaining : tokensOut;

        const newSold: u256 = SafeMath.add(sold, actualTokens);
        if (newSold > PRESALE_SUPPLY) throw new Revert('Exceeds presale supply');

        // Update state
        this._totalSold.value = newSold;
        this._totalBtc.value = SafeMath.add(this._totalBtc.value, btcAmount);
        this.contributionMap.set(buyer, newContrib);
        this.buyerTokensMap.set(buyer, SafeMath.add(this.buyerTokensMap.get(buyer), actualTokens));
        this.buyerBtcMap.set(buyer, SafeMath.add(this.buyerBtcMap.get(buyer), btcAmount));

        // Additive vote
        if (voteChoice == VOTE_BURN) {
            this._burnVotePower.value = SafeMath.add(this._burnVotePower.value, actualTokens);
            this._burnEventCount.value = SafeMath.add(this._burnEventCount.value, u256.One);
        } else if (voteChoice == VOTE_LM) {
            this._lmVotePower.value = SafeMath.add(this._lmVotePower.value, actualTokens);
            this._lmEventCount.value = SafeMath.add(this._lmEventCount.value, u256.One);
        } else {
            this._abstainPower.value = SafeMath.add(this._abstainPower.value, actualTokens);
            this._abstainEventCount.value = SafeMath.add(this._abstainEventCount.value, u256.One);
        }

        const w = new BytesWriter(32);
        w.writeU256(actualTokens);
        return w;
    }

    /**
     * Verify that this transaction includes a BTC output to the collection address.
     * Returns the payment amount in satoshis, or 0 if no matching output found.
     */
    private verifyPaymentToCollection(): u256 {
        const collectionKey: u256 = this._collectionKey.value;
        if (collectionKey.isZero()) throw new Revert('Collection address not configured');

        // Convert u256 to 32-byte big-endian array for P2TR script comparison
        const keyBytes = collectionKey.toBytes(true); // big-endian
        const collectionStr: string = this._collectionStr.value;

        const outputs = Blockchain.tx.outputs;
        let paymentAmount: u256 = u256.Zero;

        for (let i: i32 = 0; i < outputs.length; i++) {
            const output = outputs[i];
            if (output.value == 0) continue;

            let matched: bool = false;

            // Check scriptPublicKey (on-chain transactions)
            const script: Uint8Array | null = output.scriptPublicKey;
            if (script !== null) {
                matched = this.isP2TRToKey(script, keyBytes);
            }

            // Check to address string (simulation via setTransactionDetails)
            if (!matched) {
                const to: string | null = output.to;
                if (to !== null && collectionStr.length > 0 && to == collectionStr) {
                    matched = true;
                }
            }

            if (matched) {
                paymentAmount = SafeMath.add(paymentAmount, u256.fromU64(output.value));
            }
        }

        return paymentAmount;
    }

    /**
     * Check if a P2TR script pays to the given 32-byte tweaked pubkey.
     * P2TR format: OP_1 (0x51) + PUSH32 (0x20) + <32-byte tweaked pubkey>
     */
    private isP2TRToKey(script: Uint8Array, key: u8[]): bool {
        if (script.length != 34) return false;
        if (script[0] != 0x51 || script[1] != 0x20) return false;

        for (let i: i32 = 0; i < 32; i++) {
            if (script[i + 2] != key[i]) return false;
        }
        return true;
    }

    @method()
    @returns({ name: 'price', type: ABIDataTypes.UINT256 })
    public currentPrice(_calldata: Calldata): BytesWriter {
        const sold: u256 = this._totalSold.value;
        const price: u256 = SafeMath.add(
            START_PRICE,
            SafeMath.div(SafeMath.mul(PRICE_RANGE, sold), PRESALE_SUPPLY),
        );
        const w = new BytesWriter(32);
        w.writeU256(price);
        return w;
    }

    @method({ name: 'buyer', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'tokens', type: ABIDataTypes.UINT256 },
        { name: 'btcSpent', type: ABIDataTypes.UINT256 },
    )
    public buyerInfo(calldata: Calldata): BytesWriter {
        const buyer: Address = calldata.readAddress();
        const w = new BytesWriter(64);
        w.writeU256(this.buyerTokensMap.get(buyer));
        w.writeU256(this.buyerBtcMap.get(buyer));
        return w;
    }

    @method({ name: 'account', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'contribution', type: ABIDataTypes.UINT256 })
    public getContribution(calldata: Calldata): BytesWriter {
        const w = new BytesWriter(32);
        w.writeU256(this.contributionMap.get(calldata.readAddress()));
        return w;
    }

    @method()
    @returns(
        { name: 'totalSold', type: ABIDataTypes.UINT256 },
        { name: 'totalBtc', type: ABIDataTypes.UINT256 },
        { name: 'active', type: ABIDataTypes.BOOL },
        { name: 'ended', type: ABIDataTypes.BOOL },
    )
    public presaleInfo(_calldata: Calldata): BytesWriter {
        const w = new BytesWriter(32 + 32 + 1 + 1);
        w.writeU256(this._totalSold.value);
        w.writeU256(this._totalBtc.value);
        w.writeBoolean(this._isActive.value);
        w.writeBoolean(this._isEnded.value);
        return w;
    }

    @method()
    @returns(
        { name: 'burnVotePower', type: ABIDataTypes.UINT256 },
        { name: 'lmVotePower', type: ABIDataTypes.UINT256 },
        { name: 'abstainPower', type: ABIDataTypes.UINT256 },
    )
    public getVoteCounts(_calldata: Calldata): BytesWriter {
        const w = new BytesWriter(96);
        w.writeU256(this._burnVotePower.value);
        w.writeU256(this._lmVotePower.value);
        w.writeU256(this._abstainPower.value);
        return w;
    }

    @method()
    @returns(
        { name: 'burnCount', type: ABIDataTypes.UINT256 },
        { name: 'lmCount', type: ABIDataTypes.UINT256 },
        { name: 'abstainCount', type: ABIDataTypes.UINT256 },
    )
    public getVoterCounts(_calldata: Calldata): BytesWriter {
        const w = new BytesWriter(96);
        w.writeU256(this._burnEventCount.value);
        w.writeU256(this._lmEventCount.value);
        w.writeU256(this._abstainEventCount.value);
        return w;
    }

    @method()
    @returns({ name: 'maxContribution', type: ABIDataTypes.UINT256 })
    public getMaxContribution(_calldata: Calldata): BytesWriter {
        const w = new BytesWriter(32);
        w.writeU256(this._maxContrib.value);
        return w;
    }

    // ═══════════════════════════════════════════════════════════════
    // VESTING — trustless, built into presale. No manual loadVesting.
    // Admin calls startVesting() after presale ends.
    // Buyers call claim() to receive linearly-vested tokens over 30 days.
    // ═══════════════════════════════════════════════════════════════

    @method()
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public startVesting(_calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        if (!this._isEnded.value) throw new Revert('Presale not ended');
        if (this._vestingStarted.value) throw new Revert('Vesting already started');

        this._vestingStarted.value = true;
        this._vestingStartBlock.value = u256.fromU64(Blockchain.block.number);

        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    @method()
    @returns({ name: 'amount', type: ABIDataTypes.UINT256 })
    public claim(_calldata: Calldata): BytesWriter {
        if (!this._vestingStarted.value) throw new Revert('Vesting not started');

        const caller: Address = Blockchain.tx.sender;
        const totalAllocation: u256 = this.buyerTokensMap.get(caller);
        if (totalAllocation.isZero()) throw new Revert('No allocation');

        const vestedAmount: u256 = this._computeVested(totalAllocation);
        const alreadyClaimed: u256 = this.claimedMap.get(caller);
        if (vestedAmount <= alreadyClaimed) throw new Revert('Nothing to claim');

        const claimable: u256 = SafeMath.sub(vestedAmount, alreadyClaimed);
        this.claimedMap.set(caller, vestedAmount);

        // Transfer tokens from this contract to the buyer
        TransferHelper.transfer(this.tokenAddr.value, caller, claimable);

        const w = new BytesWriter(32);
        w.writeU256(claimable);
        return w;
    }

    @method({ name: 'account', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'amount', type: ABIDataTypes.UINT256 })
    public claimable(calldata: Calldata): BytesWriter {
        const account: Address = calldata.readAddress();
        const totalAllocation: u256 = this.buyerTokensMap.get(account);
        const w = new BytesWriter(32);

        if (totalAllocation.isZero() || !this._vestingStarted.value) {
            w.writeU256(u256.Zero);
            return w;
        }

        const vestedAmount: u256 = this._computeVested(totalAllocation);
        const alreadyClaimed: u256 = this.claimedMap.get(account);
        const pending: u256 = vestedAmount > alreadyClaimed
            ? SafeMath.sub(vestedAmount, alreadyClaimed)
            : u256.Zero;
        w.writeU256(pending);
        return w;
    }

    @method({ name: 'account', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'totalVesting', type: ABIDataTypes.UINT256 },
        { name: 'vestedSoFar', type: ABIDataTypes.UINT256 },
        { name: 'claimed', type: ABIDataTypes.UINT256 },
    )
    public vestingInfo(calldata: Calldata): BytesWriter {
        const account: Address = calldata.readAddress();
        const totalAllocation: u256 = this.buyerTokensMap.get(account);
        const vestedAmount: u256 = this._vestingStarted.value
            ? this._computeVested(totalAllocation)
            : u256.Zero;
        const alreadyClaimed: u256 = this.claimedMap.get(account);

        const w = new BytesWriter(32 * 3);
        w.writeU256(totalAllocation);
        w.writeU256(vestedAmount);
        w.writeU256(alreadyClaimed);
        return w;
    }

    @method()
    @returns(
        { name: 'started', type: ABIDataTypes.BOOL },
        { name: 'startBlock', type: ABIDataTypes.UINT256 },
        { name: 'vestingBlocks', type: ABIDataTypes.UINT256 },
    )
    public vestingStatus(_calldata: Calldata): BytesWriter {
        const w = new BytesWriter(1 + 32 + 32);
        w.writeBoolean(this._vestingStarted.value);
        w.writeU256(this._vestingStartBlock.value);
        w.writeU256(VESTING_BLOCKS);
        return w;
    }

    private _computeVested(totalAllocation: u256): u256 {
        if (!this._vestingStarted.value || totalAllocation.isZero()) return u256.Zero;

        const startBlock: u256 = this._vestingStartBlock.value;
        const currentBlock: u256 = u256.fromU64(Blockchain.block.number);

        if (currentBlock <= startBlock) return u256.Zero;

        const elapsed: u256 = SafeMath.sub(currentBlock, startBlock);

        // If fully vested, return total
        if (elapsed >= VESTING_BLOCKS) return totalAllocation;

        // Linear: totalAllocation * elapsed / VESTING_BLOCKS
        return SafeMath.div(SafeMath.mul(totalAllocation, elapsed), VESTING_BLOCKS);
    }

    // ═══════════════════════════════════════════════════════════════
    // GOVERNANCE RESERVE — burn or liquidity mining execution.
    // Contract is funded with 4.2B: 2.1B for sale + 2.1B reserve.
    // After presale ends, admin executes the vote result.
    // Mutual exclusion: burn OR LM, never both.
    // ═══════════════════════════════════════════════════════════════

    /**
     * Permanently burn 2.1B SCRIBE from this contract's balance.
     * Reduces total supply from 21B to 18.9B.
     */
    @method()
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public executeBurn(_calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        if (!this._isEnded.value) throw new Revert('Presale not ended');
        if (this._reserveBurnExecuted.value) throw new Revert('Burn already executed');
        if (this._reserveLmExecuted.value) throw new Revert('LM already executed');

        this._reserveBurnExecuted.value = true;

        // Cross-contract call: ScribeToken.burn(RESERVE_AMOUNT)
        const burnCd = new BytesWriter(4 + 32);
        burnCd.writeSelector(encodeSelector('burn(uint256)'));
        burnCd.writeU256(RESERVE_AMOUNT);
        Blockchain.call(this.tokenAddr.value, burnCd, true);

        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    /**
     * Transfer 2.1B SCRIBE to a farming/LP mining contract.
     * The farming contract address is provided at execution time.
     */
    @method({ name: 'farmingAddr', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public executeLiquidityMining(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        if (!this._isEnded.value) throw new Revert('Presale not ended');
        if (this._reserveLmExecuted.value) throw new Revert('LM already executed');
        if (this._reserveBurnExecuted.value) throw new Revert('Burn already executed');

        const farmingAddr: Address = calldata.readAddress();
        this._reserveLmExecuted.value = true;

        TransferHelper.transfer(this.tokenAddr.value, farmingAddr, RESERVE_AMOUNT);

        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    @method()
    @returns(
        { name: 'reserveAmount', type: ABIDataTypes.UINT256 },
        { name: 'burnExecuted', type: ABIDataTypes.BOOL },
        { name: 'lmExecuted', type: ABIDataTypes.BOOL },
        { name: 'burnWins', type: ABIDataTypes.BOOL },
    )
    public reserveStatus(_calldata: Calldata): BytesWriter {
        const w = new BytesWriter(32 + 1 + 1 + 1);
        w.writeU256(RESERVE_AMOUNT);
        w.writeBoolean(this._reserveBurnExecuted.value);
        w.writeBoolean(this._reserveLmExecuted.value);
        w.writeBoolean(this._burnVotePower.value > this._lmVotePower.value);
        return w;
    }

    /**
     * Withdraw unsold presale tokens after presale ends. One-time only.
     */
    @method({ name: 'recipient', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public withdrawUnsold(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        if (!this._isEnded.value) throw new Revert('Presale not ended');

        const recipient: Address = calldata.readAddress();
        const sold: u256 = this._totalSold.value;
        if (sold >= PRESALE_SUPPLY) throw new Revert('All tokens sold');

        const unsold: u256 = SafeMath.sub(PRESALE_SUPPLY, sold);

        // Mark as withdrawn by setting totalSold to PRESALE_SUPPLY (prevents double-call)
        this._totalSold.value = PRESALE_SUPPLY;

        TransferHelper.transfer(this.tokenAddr.value, recipient, unsold);

        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }
}
