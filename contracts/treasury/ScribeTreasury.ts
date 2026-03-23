import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
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
} from '@btc-vision/btc-runtime/runtime';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';

// Block constants (~144 blocks/day on Bitcoin)
const BLOCKS_PER_DAY: u64 = 144;
const TEAM_CLIFF_BLOCKS: u256 = u256.fromU64(BLOCKS_PER_DAY * 365);       // 1 year
const TEAM_VEST_BLOCKS: u256 = u256.fromU64(BLOCKS_PER_DAY * 365 * 4);    // 4 years total
const DEV_CLIFF_BLOCKS: u256 = u256.fromU64(BLOCKS_PER_DAY * 90);         // 3 months
const DEV_VEST_BLOCKS: u256 = u256.fromU64(BLOCKS_PER_DAY * 365 * 2);     // 2 years total
const TREASURY_LOCK_BLOCKS: u256 = u256.fromU64(BLOCKS_PER_DAY * 180);    // 6 months

// Allocation amounts in internal units (2 decimals)
const COMMUNITY_AMOUNT: u256 = u256.fromString('1050000000000');  // 10.50B * 100
const TEAM_AMOUNT: u256 = u256.fromString('105000000000');        // 1.05B * 100
const DEV_AMOUNT: u256 = u256.fromString('105000000000');         // 1.05B * 100
const TREASURY_AMOUNT: u256 = u256.fromString('105000000000');    // 1.05B * 100

@final
export class ScribeTreasury extends OP_NET {
    // ===== Stored addresses =====
    private readonly tokenAddrPointer: u16 = Blockchain.nextPointer;
    private readonly tokenAddr: StoredAddress = new StoredAddress(this.tokenAddrPointer);

    private readonly governanceAddrPointer: u16 = Blockchain.nextPointer;
    private readonly governanceAddr: StoredAddress = new StoredAddress(this.governanceAddrPointer);

    private readonly teamWalletPointer: u16 = Blockchain.nextPointer;
    private readonly teamWallet: StoredAddress = new StoredAddress(this.teamWalletPointer);

    private readonly devWalletPointer: u16 = Blockchain.nextPointer;
    private readonly devWallet: StoredAddress = new StoredAddress(this.devWalletPointer);

    // ===== TGE block (starts all clocks) =====
    private readonly tgeBlockPointer: u16 = Blockchain.nextPointer;
    private readonly _tgeBlock: StoredU256 = new StoredU256(this.tgeBlockPointer, EMPTY_POINTER);

    private readonly tgeSetPointer: u16 = Blockchain.nextPointer;
    private readonly _tgeSet: StoredBoolean = new StoredBoolean(this.tgeSetPointer, false);

    // ===== Community fund balance =====
    private readonly communityBalPointer: u16 = Blockchain.nextPointer;
    private readonly _communityBal: StoredU256 = new StoredU256(this.communityBalPointer, EMPTY_POINTER);

    // ===== Treasury balance =====
    private readonly treasuryBalPointer: u16 = Blockchain.nextPointer;
    private readonly _treasuryBal: StoredU256 = new StoredU256(this.treasuryBalPointer, EMPTY_POINTER);

    // ===== Team vesting claimed =====
    private readonly teamClaimedPointer: u16 = Blockchain.nextPointer;
    private readonly _teamClaimed: StoredU256 = new StoredU256(this.teamClaimedPointer, EMPTY_POINTER);

    // ===== Dev vesting claimed =====
    private readonly devClaimedPointer: u16 = Blockchain.nextPointer;
    private readonly _devClaimed: StoredU256 = new StoredU256(this.devClaimedPointer, EMPTY_POINTER);

    // ===== Configured flag =====
    private readonly configuredPointer: u16 = Blockchain.nextPointer;
    private readonly _configured: StoredBoolean = new StoredBoolean(this.configuredPointer, false);

    public constructor() {
        super();
    }

    public override onDeployment(_calldata: Calldata): void {}

    // ===== ADMIN: configure addresses =====
    @method(
        { name: 'token', type: ABIDataTypes.ADDRESS },
        { name: 'governance', type: ABIDataTypes.ADDRESS },
        { name: 'teamAddr', type: ABIDataTypes.ADDRESS },
        { name: 'devAddr', type: ABIDataTypes.ADDRESS },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public configure(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        if (this._configured.value) throw new Revert('Already configured');

        this.tokenAddr.value = calldata.readAddress();
        this.governanceAddr.value = calldata.readAddress();
        this.teamWallet.value = calldata.readAddress();
        this.devWallet.value = calldata.readAddress();

        // Initialize balances
        this._communityBal.value = COMMUNITY_AMOUNT;
        this._treasuryBal.value = TREASURY_AMOUNT;

        this._configured.value = true;

        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    // ===== ADMIN: set TGE block (starts all vesting clocks) =====
    @method()
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setTGE(_calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        if (!this._configured.value) throw new Revert('Not configured');
        if (this._tgeSet.value) throw new Revert('TGE already set');

        this._tgeBlock.value = u256.fromU64(Blockchain.block.number);
        this._tgeSet.value = true;

        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    // ===== GOVERNANCE: release community funds =====
    @method(
        { name: 'recipient', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public releaseCommunityFunds(calldata: Calldata): BytesWriter {
        this._onlyGovernance();

        const recipient: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();

        const bal: u256 = this._communityBal.value;
        if (amount > bal) throw new Revert('Exceeds community balance');

        // CEI: update state before external call
        this._communityBal.value = SafeMath.sub(bal, amount);

        this._transferToken(recipient, amount);

        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    // ===== GOVERNANCE: release treasury funds (after 6mo lock) =====
    @method(
        { name: 'recipient', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public releaseTreasuryFunds(calldata: Calldata): BytesWriter {
        this._onlyGovernance();
        if (!this._tgeSet.value) throw new Revert('TGE not set');

        const elapsed: u256 = this._elapsedBlocks();
        if (elapsed < TREASURY_LOCK_BLOCKS) throw new Revert('Treasury still locked');

        const recipient: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();

        const bal: u256 = this._treasuryBal.value;
        if (amount > bal) throw new Revert('Exceeds treasury balance');

        // CEI
        this._treasuryBal.value = SafeMath.sub(bal, amount);

        this._transferToken(recipient, amount);

        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    // ===== TEAM: claim vested tokens =====
    @method()
    @returns({ name: 'amount', type: ABIDataTypes.UINT256 })
    public claimTeam(_calldata: Calldata): BytesWriter {
        if (!Blockchain.tx.sender.equals(this.teamWallet.value)) throw new Revert('Not team wallet');
        if (!this._tgeSet.value) throw new Revert('TGE not set');

        const vested: u256 = this._computeVested(TEAM_AMOUNT, TEAM_CLIFF_BLOCKS, TEAM_VEST_BLOCKS);
        const claimed: u256 = this._teamClaimed.value;
        if (vested <= claimed) throw new Revert('Nothing to claim');

        const claimable: u256 = SafeMath.sub(vested, claimed);

        // CEI
        this._teamClaimed.value = vested;

        this._transferToken(this.teamWallet.value, claimable);

        const w = new BytesWriter(32);
        w.writeU256(claimable);
        return w;
    }

    // ===== DEV: claim vested tokens =====
    @method()
    @returns({ name: 'amount', type: ABIDataTypes.UINT256 })
    public claimDev(_calldata: Calldata): BytesWriter {
        if (!Blockchain.tx.sender.equals(this.devWallet.value)) throw new Revert('Not dev wallet');
        if (!this._tgeSet.value) throw new Revert('TGE not set');

        const vested: u256 = this._computeVested(DEV_AMOUNT, DEV_CLIFF_BLOCKS, DEV_VEST_BLOCKS);
        const claimed: u256 = this._devClaimed.value;
        if (vested <= claimed) throw new Revert('Nothing to claim');

        const claimable: u256 = SafeMath.sub(vested, claimed);

        // CEI
        this._devClaimed.value = vested;

        this._transferToken(this.devWallet.value, claimable);

        const w = new BytesWriter(32);
        w.writeU256(claimable);
        return w;
    }

    // ===== VIEW: community info =====
    @method()
    @returns(
        { name: 'balance', type: ABIDataTypes.UINT256 },
        { name: 'governanceAddress', type: ABIDataTypes.ADDRESS },
    )
    public communityInfo(_calldata: Calldata): BytesWriter {
        const w = new BytesWriter(32 + 32);
        w.writeU256(this._communityBal.value);
        w.writeAddress(this.governanceAddr.value);
        return w;
    }

    // ===== VIEW: team vesting info =====
    @method()
    @returns(
        { name: 'total', type: ABIDataTypes.UINT256 },
        { name: 'claimed', type: ABIDataTypes.UINT256 },
        { name: 'claimable', type: ABIDataTypes.UINT256 },
        { name: 'cliffBlocks', type: ABIDataTypes.UINT256 },
        { name: 'vestBlocks', type: ABIDataTypes.UINT256 },
        { name: 'wallet', type: ABIDataTypes.ADDRESS },
    )
    public teamVestingInfo(_calldata: Calldata): BytesWriter {
        const claimed: u256 = this._teamClaimed.value;
        let claimable: u256 = u256.Zero;
        if (this._tgeSet.value) {
            const vested: u256 = this._computeVested(TEAM_AMOUNT, TEAM_CLIFF_BLOCKS, TEAM_VEST_BLOCKS);
            claimable = vested > claimed ? SafeMath.sub(vested, claimed) : u256.Zero;
        }
        const w = new BytesWriter(32 * 5 + 32);
        w.writeU256(TEAM_AMOUNT);
        w.writeU256(claimed);
        w.writeU256(claimable);
        w.writeU256(TEAM_CLIFF_BLOCKS);
        w.writeU256(TEAM_VEST_BLOCKS);
        w.writeAddress(this.teamWallet.value);
        return w;
    }

    // ===== VIEW: dev vesting info =====
    @method()
    @returns(
        { name: 'total', type: ABIDataTypes.UINT256 },
        { name: 'claimed', type: ABIDataTypes.UINT256 },
        { name: 'claimable', type: ABIDataTypes.UINT256 },
        { name: 'cliffBlocks', type: ABIDataTypes.UINT256 },
        { name: 'vestBlocks', type: ABIDataTypes.UINT256 },
        { name: 'wallet', type: ABIDataTypes.ADDRESS },
    )
    public devVestingInfo(_calldata: Calldata): BytesWriter {
        const claimed: u256 = this._devClaimed.value;
        let claimable: u256 = u256.Zero;
        if (this._tgeSet.value) {
            const vested: u256 = this._computeVested(DEV_AMOUNT, DEV_CLIFF_BLOCKS, DEV_VEST_BLOCKS);
            claimable = vested > claimed ? SafeMath.sub(vested, claimed) : u256.Zero;
        }
        const w = new BytesWriter(32 * 5 + 32);
        w.writeU256(DEV_AMOUNT);
        w.writeU256(claimed);
        w.writeU256(claimable);
        w.writeU256(DEV_CLIFF_BLOCKS);
        w.writeU256(DEV_VEST_BLOCKS);
        w.writeAddress(this.devWallet.value);
        return w;
    }

    // ===== VIEW: treasury info =====
    @method()
    @returns(
        { name: 'balance', type: ABIDataTypes.UINT256 },
        { name: 'lockBlocks', type: ABIDataTypes.UINT256 },
        { name: 'isUnlocked', type: ABIDataTypes.BOOL },
    )
    public treasuryInfo(_calldata: Calldata): BytesWriter {
        let isUnlocked: bool = false;
        if (this._tgeSet.value) {
            isUnlocked = this._elapsedBlocks() >= TREASURY_LOCK_BLOCKS;
        }
        const w = new BytesWriter(32 + 32 + 1);
        w.writeU256(this._treasuryBal.value);
        w.writeU256(TREASURY_LOCK_BLOCKS);
        w.writeBoolean(isUnlocked);
        return w;
    }

    // ===== VIEW: all allocations in one call =====
    @method()
    @returns(
        { name: 'communityBalance', type: ABIDataTypes.UINT256 },
        { name: 'teamTotal', type: ABIDataTypes.UINT256 },
        { name: 'teamClaimed', type: ABIDataTypes.UINT256 },
        { name: 'devTotal', type: ABIDataTypes.UINT256 },
        { name: 'devClaimed', type: ABIDataTypes.UINT256 },
        { name: 'treasuryBalance', type: ABIDataTypes.UINT256 },
        { name: 'treasuryUnlocked', type: ABIDataTypes.BOOL },
        { name: 'tgeSet', type: ABIDataTypes.BOOL },
    )
    public getAllocations(_calldata: Calldata): BytesWriter {
        let treasuryUnlocked: bool = false;
        if (this._tgeSet.value) {
            treasuryUnlocked = this._elapsedBlocks() >= TREASURY_LOCK_BLOCKS;
        }
        const w = new BytesWriter(32 * 6 + 1 + 1);
        w.writeU256(this._communityBal.value);
        w.writeU256(TEAM_AMOUNT);
        w.writeU256(this._teamClaimed.value);
        w.writeU256(DEV_AMOUNT);
        w.writeU256(this._devClaimed.value);
        w.writeU256(this._treasuryBal.value);
        w.writeBoolean(treasuryUnlocked);
        w.writeBoolean(this._tgeSet.value);
        return w;
    }

    // ===== PRIVATE: governance-only check =====
    private _onlyGovernance(): void {
        if (this.governanceAddr.isDead()) throw new Revert('Governance not set');
        if (!Blockchain.tx.sender.equals(this.governanceAddr.value)) {
            throw new Revert('Only governance');
        }
    }

    // ===== PRIVATE: compute vested amount with cliff =====
    private _computeVested(totalAmount: u256, cliffBlocks: u256, vestBlocks: u256): u256 {
        if (!this._tgeSet.value) return u256.Zero;
        if (totalAmount.isZero()) return u256.Zero;

        const elapsed: u256 = this._elapsedBlocks();

        // Before cliff: nothing vested
        if (elapsed < cliffBlocks) return u256.Zero;

        // After full vest period: everything vested
        if (elapsed >= vestBlocks) return totalAmount;

        // Linear vesting: totalAmount * elapsed / vestBlocks
        return SafeMath.div(SafeMath.mul(totalAmount, elapsed), vestBlocks);
    }

    // ===== PRIVATE: blocks since TGE =====
    private _elapsedBlocks(): u256 {
        const tge: u256 = this._tgeBlock.value;
        const current: u256 = u256.fromU64(Blockchain.block.number);
        if (current <= tge) return u256.Zero;
        return SafeMath.sub(current, tge);
    }

    // ===== PRIVATE: transfer token via cross-contract call =====
    private _transferToken(recipient: Address, amount: u256): void {
        if (this.tokenAddr.isDead()) throw new Revert('Token not set');
        const cd = new BytesWriter(4 + 32 + 32);
        cd.writeSelector(encodeSelector('transfer(address,uint256)'));
        cd.writeAddress(recipient);
        cd.writeU256(amount);
        Blockchain.call(this.tokenAddr.value, cd, true);
    }
}
