import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    OP_NET,
    Revert,
    SafeMath,
    StoredAddress,
    StoredBoolean,
    StoredU256,
    TransferHelper,
} from '@btc-vision/btc-runtime/runtime';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';

// Block-based time constants (~10 min/block on Bitcoin)
// 3 months cliff = ~90 days * 144 blocks/day = 12,960 blocks
const DEV_CLIFF_BLOCKS: u256 = u256.fromU64(12960);
// 2 years total vest = ~730 days * 144 = 105,120 blocks
const DEV_VEST_BLOCKS: u256 = u256.fromU64(105120);
// 1 year cliff = ~365 days * 144 = 52,560 blocks
const TEAM_CLIFF_BLOCKS: u256 = u256.fromU64(52560);
// 4 years total vest = ~1460 days * 144 = 210,240 blocks
const TEAM_VEST_BLOCKS: u256 = u256.fromU64(210240);

const tokenAddrPointer: u16 = Blockchain.nextPointer;
const vestingStartedPointer: u16 = Blockchain.nextPointer;
const vestingStartBlockPointer: u16 = Blockchain.nextPointer;

// Dev schedule
const devWalletPointer: u16 = Blockchain.nextPointer;
const devTotalPointer: u16 = Blockchain.nextPointer;
const devClaimedPointer: u16 = Blockchain.nextPointer;

// Team schedule
const teamWalletPointer: u16 = Blockchain.nextPointer;
const teamTotalPointer: u16 = Blockchain.nextPointer;
const teamClaimedPointer: u16 = Blockchain.nextPointer;

/**
 * ScribeVesting — Team + Dev token vesting.
 *
 * Development: 1.05B SCRIBE, 2-year linear vest, 3-month cliff.
 * Team: 1.05B SCRIBE, 4-year linear vest, 1-year cliff.
 *
 * Admin sets wallet addresses for each schedule.
 * Vesting starts when admin calls startVesting().
 * Designated wallets call claimDev() / claimTeam() to pull vested tokens.
 */
@final
export class ScribeVesting extends OP_NET {
    private readonly tokenAddr: StoredAddress;
    private readonly vestingStarted: StoredBoolean;
    private readonly vestingStartBlock: StoredU256;

    private readonly devWallet: StoredAddress;
    private readonly devTotal: StoredU256;
    private readonly devClaimed: StoredU256;

    private readonly teamWallet: StoredAddress;
    private readonly teamTotal: StoredU256;
    private readonly teamClaimed: StoredU256;

    public constructor() {
        super();
        this.tokenAddr = new StoredAddress(tokenAddrPointer);
        this.vestingStarted = new StoredBoolean(vestingStartedPointer, false);
        this.vestingStartBlock = new StoredU256(vestingStartBlockPointer, EMPTY_POINTER);
        this.devWallet = new StoredAddress(devWalletPointer);
        this.devTotal = new StoredU256(devTotalPointer, EMPTY_POINTER);
        this.devClaimed = new StoredU256(devClaimedPointer, EMPTY_POINTER);
        this.teamWallet = new StoredAddress(teamWalletPointer);
        this.teamTotal = new StoredU256(teamTotalPointer, EMPTY_POINTER);
        this.teamClaimed = new StoredU256(teamClaimedPointer, EMPTY_POINTER);
    }

    public override onDeployment(calldata: Calldata): void {
        const tokenAddr: Address = calldata.readAddress();
        const devAmount: u256 = calldata.readU256();
        const teamAmount: u256 = calldata.readU256();

        this.tokenAddr.value = tokenAddr;
        this.devTotal.value = devAmount;
        this.teamTotal.value = teamAmount;
        this.devClaimed.value = u256.Zero;
        this.teamClaimed.value = u256.Zero;
        this.vestingStarted.value = false;
    }

    // ── Admin ───────────────────────────────────────────────────────────

    @method({ name: 'wallet', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setDevWallet(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this.devWallet.value = calldata.readAddress();
        const w: BytesWriter = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    @method({ name: 'wallet', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setTeamWallet(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this.teamWallet.value = calldata.readAddress();
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
    public claimDev(_calldata: Calldata): BytesWriter {
        if (!this.vestingStarted.value) throw new Revert('Vesting not started');
        if (this.devWallet.isDead()) throw new Revert('Dev wallet not set');

        const caller: Address = Blockchain.tx.sender;
        const devAddr: Address = this.devWallet.value;
        if (!caller.equals(devAddr)) throw new Revert('Not dev wallet');

        const vested: u256 = this._computeVested(this.devTotal.value, DEV_CLIFF_BLOCKS, DEV_VEST_BLOCKS);
        const claimed: u256 = this.devClaimed.value;
        if (vested <= claimed) throw new Revert('Nothing to claim');

        const claimable: u256 = SafeMath.sub(vested, claimed);
        this.devClaimed.value = vested;

        TransferHelper.transfer(this.tokenAddr.value, devAddr, claimable);

        const w: BytesWriter = new BytesWriter(32);
        w.writeU256(claimable);
        return w;
    }

    @method()
    @returns({ name: 'amount', type: ABIDataTypes.UINT256 })
    public claimTeam(_calldata: Calldata): BytesWriter {
        if (!this.vestingStarted.value) throw new Revert('Vesting not started');
        if (this.teamWallet.isDead()) throw new Revert('Team wallet not set');

        const caller: Address = Blockchain.tx.sender;
        const teamAddr: Address = this.teamWallet.value;
        if (!caller.equals(teamAddr)) throw new Revert('Not team wallet');

        const vested: u256 = this._computeVested(this.teamTotal.value, TEAM_CLIFF_BLOCKS, TEAM_VEST_BLOCKS);
        const claimed: u256 = this.teamClaimed.value;
        if (vested <= claimed) throw new Revert('Nothing to claim');

        const claimable: u256 = SafeMath.sub(vested, claimed);
        this.teamClaimed.value = vested;

        TransferHelper.transfer(this.tokenAddr.value, teamAddr, claimable);

        const w: BytesWriter = new BytesWriter(32);
        w.writeU256(claimable);
        return w;
    }

    // ── View ────────────────────────────────────────────────────────────

    @view
    @method()
    @returns(
        { name: 'devTotal', type: ABIDataTypes.UINT256 },
        { name: 'devVested', type: ABIDataTypes.UINT256 },
        { name: 'devClaimed', type: ABIDataTypes.UINT256 },
        { name: 'devClaimable', type: ABIDataTypes.UINT256 },
    )
    public devVestingInfo(_calldata: Calldata): BytesWriter {
        const total: u256 = this.devTotal.value;
        const vested: u256 = this.vestingStarted.value
            ? this._computeVested(total, DEV_CLIFF_BLOCKS, DEV_VEST_BLOCKS) : u256.Zero;
        const claimed: u256 = this.devClaimed.value;
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
        { name: 'teamTotal', type: ABIDataTypes.UINT256 },
        { name: 'teamVested', type: ABIDataTypes.UINT256 },
        { name: 'teamClaimed', type: ABIDataTypes.UINT256 },
        { name: 'teamClaimable', type: ABIDataTypes.UINT256 },
    )
    public teamVestingInfo(_calldata: Calldata): BytesWriter {
        const total: u256 = this.teamTotal.value;
        const vested: u256 = this.vestingStarted.value
            ? this._computeVested(total, TEAM_CLIFF_BLOCKS, TEAM_VEST_BLOCKS) : u256.Zero;
        const claimed: u256 = this.teamClaimed.value;
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

    private _computeVested(total: u256, cliffBlocks: u256, vestBlocks: u256): u256 {
        if (!this.vestingStarted.value || total.isZero()) return u256.Zero;

        const startBlock: u256 = this.vestingStartBlock.value;
        const currentBlock: u256 = u256.fromU64(Blockchain.block.number);
        if (currentBlock <= startBlock) return u256.Zero;

        const elapsed: u256 = SafeMath.sub(currentBlock, startBlock);

        // Before cliff: nothing vested
        if (elapsed < cliffBlocks) return u256.Zero;

        // After full vest: everything vested
        if (elapsed >= vestBlocks) return total;

        // Linear: total * elapsed / vestBlocks
        return SafeMath.div(SafeMath.mul(total, elapsed), vestBlocks);
    }
}
