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

class RewardAllocatedEvent extends NetEvent {
    constructor(recipient: Address, amount: u256) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
        data.writeAddress(recipient);
        data.writeU256(amount);
        super('RewardAllocated', data);
    }
}

class RewardClaimedEvent extends NetEvent {
    constructor(claimant: Address, amount: u256) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
        data.writeAddress(claimant);
        data.writeU256(amount);
        super('RewardClaimed', data);
    }
}

const tokenAddressPointer: u16 = Blockchain.nextPointer;
const pausedPointer: u16 = Blockchain.nextPointer;
const allocatedMapPointer: u16 = Blockchain.nextPointer;
const claimedMapPointer: u16 = Blockchain.nextPointer;
const totalAllocatedPointer: u16 = Blockchain.nextPointer;
const totalClaimedPointer: u16 = Blockchain.nextPointer;

/**
 * ScribeRewardsTreasury — Referral rewards pool for $SCRIBE.
 *
 * This contract is the DESTINATION for the token's transfer tax.
 * When tax is enabled on ScribeToken, taxed amounts flow here automatically.
 * Admin allocates rewards to individual users. Users call claimRewards() to pull.
 *
 * Must be added to ScribeToken's tax-exempt list (via setRewardsAddress)
 * so that claim payouts are not double-taxed.
 */
@final
export class ScribeRewardsTreasury extends ReentrancyGuard {
    private readonly tokenAddress: StoredAddress;
    private readonly paused: StoredBoolean;
    private readonly allocatedMap: AddressMemoryMap;
    private readonly claimedMap: AddressMemoryMap;
    private readonly totalAllocated: StoredU256;
    private readonly totalClaimed: StoredU256;

    public constructor() {
        super();
        this.tokenAddress = new StoredAddress(tokenAddressPointer);
        this.paused = new StoredBoolean(pausedPointer, false);
        this.allocatedMap = new AddressMemoryMap(allocatedMapPointer);
        this.claimedMap = new AddressMemoryMap(claimedMapPointer);
        this.totalAllocated = new StoredU256(totalAllocatedPointer, EMPTY_POINTER);
        this.totalClaimed = new StoredU256(totalClaimedPointer, EMPTY_POINTER);
    }

    public override onDeployment(calldata: Calldata): void {
        const tokenAddr: Address = calldata.readAddress();
        this.tokenAddress.value = tokenAddr;
        this.paused.value = false;
        this.totalAllocated.value = u256.Zero;
        this.totalClaimed.value = u256.Zero;
    }

    // ── User: Claim ─────────────────────────────────────────────────────

    @method()
    @emit('RewardClaimed')
    @returns({ name: 'claimed', type: ABIDataTypes.UINT256 })
    public claimRewards(_calldata: Calldata): BytesWriter {
        if (this.paused.value) throw new Revert('Rewards paused');

        const claimant: Address = Blockchain.tx.sender;
        const allocated: u256 = this.allocatedMap.get(claimant);
        const claimed: u256 = this.claimedMap.get(claimant);

        if (allocated <= claimed) throw new Revert('No rewards to claim');

        const pending: u256 = SafeMath.sub(allocated, claimed);

        // Effects before interactions — CEI
        this.claimedMap.set(claimant, allocated);
        this.totalClaimed.value = SafeMath.add(this.totalClaimed.value, pending);

        // Interaction
        TransferHelper.transfer(this.tokenAddress.value, claimant, pending);

        this.emitEvent(new RewardClaimedEvent(claimant, pending));

        const w: BytesWriter = new BytesWriter(U256_BYTE_LENGTH);
        w.writeU256(pending);
        return w;
    }

    // ── Admin: Allocate ─────────────────────────────────────────────────

    @method(
        { name: 'recipient', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @emit('RewardAllocated')
    public allocateReward(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const recipient: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();
        if (amount.isZero()) throw new Revert('Amount must be > 0');

        this._allocate(recipient, amount);
        this.emitEvent(new RewardAllocatedEvent(recipient, amount));
        return new BytesWriter(0);
    }

    @method()
    public pause(_calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this.paused.value = true;
        return new BytesWriter(0);
    }

    @method()
    public unpause(_calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this.paused.value = false;
        return new BytesWriter(0);
    }

    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    public withdrawUnallocated(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        const amount: u256 = calldata.readU256();
        if (amount.isZero()) throw new Revert('Amount must be > 0');
        TransferHelper.transfer(this.tokenAddress.value, Blockchain.tx.sender, amount);
        return new BytesWriter(0);
    }

    // ── View ────────────────────────────────────────────────────────────

    @view
    @method({ name: 'account', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'allocated', type: ABIDataTypes.UINT256 },
        { name: 'claimed', type: ABIDataTypes.UINT256 },
        { name: 'pending', type: ABIDataTypes.UINT256 },
    )
    public getClaimable(calldata: Calldata): BytesWriter {
        const account: Address = calldata.readAddress();
        const allocated: u256 = this.allocatedMap.get(account);
        const claimed: u256 = this.claimedMap.get(account);
        const pending: u256 = allocated > claimed ? SafeMath.sub(allocated, claimed) : u256.Zero;

        const w: BytesWriter = new BytesWriter(U256_BYTE_LENGTH * 3);
        w.writeU256(allocated);
        w.writeU256(claimed);
        w.writeU256(pending);
        return w;
    }

    @view
    @method()
    @returns(
        { name: 'totalAllocated', type: ABIDataTypes.UINT256 },
        { name: 'totalClaimed', type: ABIDataTypes.UINT256 },
        { name: 'paused', type: ABIDataTypes.BOOL },
    )
    public getState(_calldata: Calldata): BytesWriter {
        const w: BytesWriter = new BytesWriter(U256_BYTE_LENGTH * 2 + 1);
        w.writeU256(this.totalAllocated.value);
        w.writeU256(this.totalClaimed.value);
        w.writeBoolean(this.paused.value);
        return w;
    }

    // ── Internal ────────────────────────────────────────────────────────

    private _allocate(recipient: Address, amount: u256): void {
        const prev: u256 = this.allocatedMap.get(recipient);
        this.allocatedMap.set(recipient, SafeMath.add(prev, amount));
        this.totalAllocated.value = SafeMath.add(this.totalAllocated.value, amount);
    }
}
