import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    Revert,
    SafeMath,
    StoredAddress,
    StoredBoolean,
    StoredU256,
    TransferHelper,
} from '@btc-vision/btc-runtime/runtime';
import { ReentrancyGuard } from '@btc-vision/btc-runtime/runtime/contracts/ReentrancyGuard';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';

// 1 year = ~365 days * 144 blocks/day = 52,560 blocks
const VEST_BLOCKS: u256 = u256.fromU64(52560);

const tokenAddrPointer: u16 = Blockchain.nextPointer;
const vestingStartedPointer: u16 = Blockchain.nextPointer;
const vestingStartBlockPointer: u16 = Blockchain.nextPointer;
const treasuryWalletPointer: u16 = Blockchain.nextPointer;
const treasuryTotalPointer: u16 = Blockchain.nextPointer;
const treasuryClaimedPointer: u16 = Blockchain.nextPointer;

/**
 * ScribeTreasury — Operational treasury vesting.
 *
 * Single pool: 1.05B SCRIBE (5% of supply).
 * 1-year linear vesting, NO cliff — tokens begin unlocking immediately after startVesting().
 * Designed for operational partnerships throughout Year 1.
 *
 * Only the designated treasury wallet can call claim().
 * Admin (deployer) sets wallet address and starts vesting.
 */
@final
export class ScribeTreasury extends ReentrancyGuard {
    private readonly tokenAddr: StoredAddress;
    private readonly vestingStarted: StoredBoolean;
    private readonly vestingStartBlock: StoredU256;
    private readonly treasuryWallet: StoredAddress;
    private readonly treasuryTotal: StoredU256;
    private readonly treasuryClaimed: StoredU256;

    public constructor() {
        super();
        this.tokenAddr = new StoredAddress(tokenAddrPointer);
        this.vestingStarted = new StoredBoolean(vestingStartedPointer, false);
        this.vestingStartBlock = new StoredU256(vestingStartBlockPointer, EMPTY_POINTER);
        this.treasuryWallet = new StoredAddress(treasuryWalletPointer);
        this.treasuryTotal = new StoredU256(treasuryTotalPointer, EMPTY_POINTER);
        this.treasuryClaimed = new StoredU256(treasuryClaimedPointer, EMPTY_POINTER);
    }

    public override onDeployment(calldata: Calldata): void {
        const tokenAddr: Address = calldata.readAddress();
        const treasuryAmount: u256 = calldata.readU256();

        this.tokenAddr.value = tokenAddr;
        this.treasuryTotal.value = treasuryAmount;
        this.treasuryClaimed.value = u256.Zero;
        this.vestingStarted.value = false;
    }

    // ── Admin ───────────────────────────────────────────────────────────

    @method({ name: 'wallet', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setTreasuryWallet(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this.treasuryWallet.value = calldata.readAddress();
        const w: BytesWriter = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    @method()
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public startVesting(_calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        if (this.vestingStarted.value) throw new Revert('Vesting already started');
        this.vestingStarted.value = true;
        this.vestingStartBlock.value = u256.fromU64(Blockchain.block.number);
        const w: BytesWriter = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    // ── Claim ───────────────────────────────────────────────────────────

    @method()
    @returns({ name: 'amount', type: ABIDataTypes.UINT256 })
    public claim(_calldata: Calldata): BytesWriter {
        if (!this.vestingStarted.value) throw new Revert('Vesting not started');
        if (this.treasuryWallet.isDead()) throw new Revert('Treasury wallet not set');

        const caller: Address = Blockchain.tx.sender;
        const walletAddr: Address = this.treasuryWallet.value;
        if (!caller.equals(walletAddr)) throw new Revert('Not treasury wallet');

        const vested: u256 = this._computeVested();
        const claimed: u256 = this.treasuryClaimed.value;
        if (vested <= claimed) throw new Revert('Nothing to claim');

        const claimable: u256 = SafeMath.sub(vested, claimed);

        // CEI: update claimed amount before external transfer
        this.treasuryClaimed.value = vested;

        // Interaction: transfer tokens
        TransferHelper.transfer(this.tokenAddr.value, walletAddr, claimable);

        const w: BytesWriter = new BytesWriter(32);
        w.writeU256(claimable);
        return w;
    }

    // ── View ────────────────────────────────────────────────────────────

    @view
    @method()
    @returns(
        { name: 'total', type: ABIDataTypes.UINT256 },
        { name: 'vested', type: ABIDataTypes.UINT256 },
        { name: 'claimed', type: ABIDataTypes.UINT256 },
        { name: 'claimable', type: ABIDataTypes.UINT256 },
    )
    public vestingInfo(_calldata: Calldata): BytesWriter {
        const total: u256 = this.treasuryTotal.value;
        const vested: u256 = this.vestingStarted.value ? this._computeVested() : u256.Zero;
        const claimed: u256 = this.treasuryClaimed.value;
        const claimable: u256 = vested > claimed ? SafeMath.sub(vested, claimed) : u256.Zero;

        const w: BytesWriter = new BytesWriter(32 * 4);
        w.writeU256(total);
        w.writeU256(vested);
        w.writeU256(claimed);
        w.writeU256(claimable);
        return w;
    }

    @view
    @method()
    @returns(
        { name: 'started', type: ABIDataTypes.BOOL },
        { name: 'startBlock', type: ABIDataTypes.UINT256 },
    )
    public vestingStatus(_calldata: Calldata): BytesWriter {
        const w: BytesWriter = new BytesWriter(1 + 32);
        w.writeBoolean(this.vestingStarted.value);
        w.writeU256(this.vestingStartBlock.value);
        return w;
    }

    // ── Internal ────────────────────────────────────────────────────────

    private _computeVested(): u256 {
        const total: u256 = this.treasuryTotal.value;
        if (!this.vestingStarted.value || total.isZero()) return u256.Zero;

        const startBlock: u256 = this.vestingStartBlock.value;
        const currentBlock: u256 = u256.fromU64(Blockchain.block.number);
        if (currentBlock <= startBlock) return u256.Zero;

        const elapsed: u256 = SafeMath.sub(currentBlock, startBlock);

        // No cliff — linear from block 0
        // After full vest period: everything vested
        if (elapsed >= VEST_BLOCKS) return total;

        // Linear: total * elapsed / VEST_BLOCKS
        return SafeMath.div(SafeMath.mul(total, elapsed), VEST_BLOCKS);
    }
}
