import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    AddressMemoryMap,
    Blockchain,
    BytesWriter,
    Calldata,
    NetEvent,
    Revert,
    SafeMath,
    StoredAddress,
    StoredBoolean,
    StoredU256,
    TransferHelper,
} from '@btc-vision/btc-runtime/runtime';
import { ReentrancyGuard } from '@btc-vision/btc-runtime/runtime/contracts/ReentrancyGuard';
import { ADDRESS_BYTE_LENGTH, U256_BYTE_LENGTH } from '@btc-vision/btc-runtime/runtime/utils';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';

class ClaimEvent extends NetEvent {
    constructor(claimant: Address, amount: u256, blockNumber: u256) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH * 2);
        data.writeAddress(claimant);
        data.writeU256(amount);
        data.writeU256(blockNumber);
        super('Claim', data);
    }
}

const tokenAddressPointer: u16 = Blockchain.nextPointer;
const claimAmountPointer: u16 = Blockchain.nextPointer;
const cooldownBlocksPointer: u16 = Blockchain.nextPointer;
const pausedPointer: u16 = Blockchain.nextPointer;
const lastClaimPointer: u16 = Blockchain.nextPointer;

/**
 * ScribeFaucet v2 — Token drip faucet for $SCRIBE on OPNet.
 *
 * Any wallet can call claim() once per cooldown window to receive a fixed
 * amount of SCRIBE. The faucet is funded via fund() (pull-based transfer).
 *
 * Admin controls (deployer only):
 *   - setClaimAmount(u256)    — adjust tokens per claim
 *   - setCooldownBlocks(u256) — adjust cooldown window (36 blocks ~ 6 hours)
 *   - pause() / unpause()     — emergency stop
 *
 * Simplified from v1: removed registry/registeredOnly dependency.
 */
@final
export class ScribeFaucet extends ReentrancyGuard {
    private readonly tokenAddress: StoredAddress;
    private readonly claimAmount: StoredU256;
    private readonly cooldownBlocks: StoredU256;
    private readonly paused: StoredBoolean;
    private readonly lastClaim: AddressMemoryMap;

    public constructor() {
        super();

        this.tokenAddress = new StoredAddress(tokenAddressPointer);
        this.claimAmount = new StoredU256(claimAmountPointer, EMPTY_POINTER);
        this.cooldownBlocks = new StoredU256(cooldownBlocksPointer, EMPTY_POINTER);
        this.paused = new StoredBoolean(pausedPointer, false);
        this.lastClaim = new AddressMemoryMap(lastClaimPointer);
    }

    public override onDeployment(calldata: Calldata): void {
        const tokenAddr: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();
        const cooldown: u256 = calldata.readU256();

        this.tokenAddress.value = tokenAddr;
        this.claimAmount.value = amount;
        this.cooldownBlocks.value = cooldown;
        this.paused.value = false;
    }

    // ── Public: Claim ───────────────────────────────────────────────────

    /**
     * claim() — Receive claimAmount tokens. Reverts if:
     *   - faucet is paused
     *   - cooldown has not elapsed since last claim
     *   - claimAmount is zero
     */
    @method()
    @emit('Claim')
    public claim(_calldata: Calldata): BytesWriter {
        if (this.paused.value) {
            throw new Revert('Faucet is paused');
        }

        const claimant: Address = Blockchain.tx.sender;
        const currentBlock: u256 = u256.fromU64(Blockchain.block.number);
        const cooldown: u256 = this.cooldownBlocks.value;

        const lastBlock: u256 = this.lastClaim.get(claimant);

        if (!lastBlock.isZero()) {
            if (currentBlock < lastBlock) {
                throw new Revert('Block number inconsistency');
            }
            const elapsed: u256 = SafeMath.sub(currentBlock, lastBlock);
            if (elapsed < cooldown) {
                throw new Revert('Cooldown not elapsed');
            }
        }

        const amount: u256 = this.claimAmount.value;
        if (amount.isZero()) {
            throw new Revert('Claim amount is zero');
        }

        // Effects before interactions — CEI pattern
        this.lastClaim.set(claimant, currentBlock);

        // Interaction: transfer tokens from faucet balance to claimant
        TransferHelper.transfer(this.tokenAddress.value, claimant, amount);

        this.emitEvent(new ClaimEvent(claimant, amount, currentBlock));

        return new BytesWriter(0);
    }

    // ── Public: Fund ────────────────────────────────────────────────────

    /**
     * fund(amount) — Anyone can donate SCRIBE to keep the faucet running.
     * Pulls tokens from caller via safeTransferFrom.
     */
    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    public fund(calldata: Calldata): BytesWriter {
        const amount: u256 = calldata.readU256();
        if (amount.isZero()) {
            throw new Revert('Amount cannot be zero');
        }

        TransferHelper.safeTransferFrom(
            this.tokenAddress.value,
            Blockchain.tx.sender,
            Blockchain.contractAddress,
            amount,
        );

        return new BytesWriter(0);
    }

    // ── View: getState ──────────────────────────────────────────────────

    /**
     * getState(claimant) — Read-only view for frontend.
     */
    @view
    @method({ name: 'claimant', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'claimAmount', type: ABIDataTypes.UINT256 },
        { name: 'cooldownBlocks', type: ABIDataTypes.UINT256 },
        { name: 'paused', type: ABIDataTypes.BOOL },
        { name: 'lastClaimBlock', type: ABIDataTypes.UINT256 },
        { name: 'currentBlock', type: ABIDataTypes.UINT256 },
    )
    public getState(calldata: Calldata): BytesWriter {
        const addr: Address = calldata.readAddress();
        const lastBlock: u256 = this.lastClaim.get(addr);
        const cur: u256 = u256.fromU64(Blockchain.block.number);

        const response: BytesWriter = new BytesWriter(U256_BYTE_LENGTH * 4 + 1);
        response.writeU256(this.claimAmount.value);
        response.writeU256(this.cooldownBlocks.value);
        response.writeBoolean(this.paused.value);
        response.writeU256(lastBlock);
        response.writeU256(cur);
        return response;
    }

    // ── Admin: Configuration ────────────────────────────────────────────

    /**
     * setClaimAmount(amount) — Deployer only. Update per-claim token amount.
     */
    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    public setClaimAmount(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        const amount: u256 = calldata.readU256();
        if (amount.isZero()) {
            throw new Revert('Amount must be > 0');
        }
        this.claimAmount.value = amount;
        return new BytesWriter(0);
    }

    /**
     * setCooldownBlocks(blocks) — Deployer only. Update cooldown window.
     * 36 blocks ~ 6 hours on OPNet (10 min/block).
     */
    @method({ name: 'blocks', type: ABIDataTypes.UINT256 })
    public setCooldownBlocks(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        const blocks: u256 = calldata.readU256();
        if (blocks.isZero()) {
            throw new Revert('Cooldown must be > 0');
        }
        this.cooldownBlocks.value = blocks;
        return new BytesWriter(0);
    }

    /** pause() — Deployer only. Stops all claims. */
    @method()
    public pause(_calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this.paused.value = true;
        return new BytesWriter(0);
    }

    /** unpause() — Deployer only. Resumes claims. */
    @method()
    public unpause(_calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this.paused.value = false;
        return new BytesWriter(0);
    }
}
