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
    StoredU256,
    TransferHelper,
} from '@btc-vision/btc-runtime/runtime';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';
import { StoredMapU256 } from '@btc-vision/btc-runtime/runtime/storage/maps/StoredMapU256';

// Voting period defaults and bounds (~10 min/block on Bitcoin)
const DEFAULT_VOTING_BLOCKS: u256 = u256.fromU64(1008);  // ~7 days
const MIN_VOTING_BLOCKS: u256 = u256.fromU64(6);          // ~1 hour
const MAX_VOTING_BLOCKS: u256 = u256.fromU64(4320);       // ~30 days
const MAX_PROPOSALS: u256 = u256.fromU64(1000);

// Pool identifiers
const POOL_RESERVE: u256 = u256.One;    // 2.1B Reserve Pool
const POOL_COMMUNITY: u256 = u256.fromU64(2); // 10.5B Community Pool

/**
 * ScribeGovernance v2 — "The Board"
 *
 * Holds two separate fund pools:
 * - Reserve Pool: 2.1B SCRIBE (10%) — first vote: burn or add to NativeSwap pool
 * - Community Pool: 10.5B SCRIBE (50%) — general ecosystem fund, governance-gated
 *
 * Total locked: 12.6B tokens (60% of supply).
 * Tokens CANNOT move without a successful governance vote.
 *
 * Voting: token-weighted (1 SCRIBE = 1 vote), 7-day period, no quorum.
 * Admin creates proposals and executes after vote closes.
 * Vote power is the voter's balance at time of voting.
 */
@final
export class ScribeGovernance extends OP_NET {
    private readonly tokenAddrPointer: u16 = Blockchain.nextPointer;
    private readonly tokenAddr: StoredAddress = new StoredAddress(this.tokenAddrPointer);

    private readonly proposalCountPointer: u16 = Blockchain.nextPointer;
    private readonly _proposalCount: StoredU256 = new StoredU256(this.proposalCountPointer, EMPTY_POINTER);

    // Pool balances (tracked internally, actual tokens held by this contract)
    private readonly reserveBalancePointer: u16 = Blockchain.nextPointer;
    private readonly _reserveBalance: StoredU256 = new StoredU256(this.reserveBalancePointer, EMPTY_POINTER);

    private readonly communityBalancePointer: u16 = Blockchain.nextPointer;
    private readonly _communityBalance: StoredU256 = new StoredU256(this.communityBalancePointer, EMPTY_POINTER);

    private readonly votingPeriodPointer: u16 = Blockchain.nextPointer;
    private readonly _votingPeriod: StoredU256 = new StoredU256(this.votingPeriodPointer, EMPTY_POINTER);

    // Per-proposal storage
    private readonly yesVotesPointer: u16 = Blockchain.nextPointer;
    private readonly yesVotesMap: StoredMapU256 = new StoredMapU256(this.yesVotesPointer);

    private readonly noVotesPointer: u16 = Blockchain.nextPointer;
    private readonly noVotesMap: StoredMapU256 = new StoredMapU256(this.noVotesPointer);

    private readonly endBlockPointer: u16 = Blockchain.nextPointer;
    private readonly endBlockMap: StoredMapU256 = new StoredMapU256(this.endBlockPointer);

    private readonly snapshotBlockPointer: u16 = Blockchain.nextPointer;
    private readonly snapshotBlockMap: StoredMapU256 = new StoredMapU256(this.snapshotBlockPointer);

    // Pool assignment per proposal (1=Reserve, 2=Community)
    private readonly poolPointer: u16 = Blockchain.nextPointer;
    private readonly poolMap: StoredMapU256 = new StoredMapU256(this.poolPointer);

    // Recipient per proposal
    private readonly recipientPointer: u16 = Blockchain.nextPointer;
    private readonly recipientMap: StoredMapU256 = new StoredMapU256(this.recipientPointer);

    // Amount per proposal
    private readonly amountPointer: u16 = Blockchain.nextPointer;
    private readonly amountMap: StoredMapU256 = new StoredMapU256(this.amountPointer);

    // Action type: 1=transfer, 2=burn
    private readonly actionPointer: u16 = Blockchain.nextPointer;
    private readonly actionMap: StoredMapU256 = new StoredMapU256(this.actionPointer);

    // Executed flag
    private readonly executedPointer: u16 = Blockchain.nextPointer;
    private readonly executedMap: StoredMapU256 = new StoredMapU256(this.executedPointer);

    // Vote record: composite key (proposalId XOR voter hash) → 1 if voted
    private readonly voterRecordPointer: u16 = Blockchain.nextPointer;
    private readonly voterRecordMap: StoredMapU256 = new StoredMapU256(this.voterRecordPointer);

    public constructor() {
        super();
    }

    public override onDeployment(calldata: Calldata): void {
        const tokenAddr: Address = calldata.readAddress();
        const reserveAmount: u256 = calldata.readU256();
        const communityAmount: u256 = calldata.readU256();

        this.tokenAddr.value = tokenAddr;
        this._reserveBalance.value = reserveAmount;
        this._communityBalance.value = communityAmount;
        this._votingPeriod.value = DEFAULT_VOTING_BLOCKS;
    }

    // ── Admin: Create Proposal ──────────────────────────────────────────

    @method(
        { name: 'pool', type: ABIDataTypes.UINT256 },
        { name: 'action', type: ABIDataTypes.UINT256 },
        { name: 'recipient', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'proposalId', type: ABIDataTypes.UINT256 })
    public createProposal(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const pool: u256 = calldata.readU256();
        const action: u256 = calldata.readU256();
        const recipient: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();

        if (pool != POOL_RESERVE && pool != POOL_COMMUNITY) throw new Revert('Invalid pool');
        if (action.isZero() || action > u256.fromU64(2)) throw new Revert('Invalid action');
        if (amount.isZero()) throw new Revert('Amount must be > 0');

        // Verify pool has sufficient balance
        const poolBalance: u256 = pool == POOL_RESERVE ? this._reserveBalance.value : this._communityBalance.value;
        if (amount > poolBalance) throw new Revert('Exceeds pool balance');

        const count: u256 = this._proposalCount.value;
        if (count >= MAX_PROPOSALS) throw new Revert('Max proposals reached');

        const proposalId: u256 = SafeMath.add(count, u256.One);
        this._proposalCount.value = proposalId;

        const endBlock: u256 = SafeMath.add(u256.fromU64(Blockchain.block.number), this._votingPeriod.value);
        this.endBlockMap.set(proposalId, endBlock);
        this.snapshotBlockMap.set(proposalId, u256.fromU64(Blockchain.block.number));
        this.yesVotesMap.set(proposalId, u256.Zero);
        this.noVotesMap.set(proposalId, u256.Zero);
        this.poolMap.set(proposalId, pool);
        this.actionMap.set(proposalId, action);
        this.recipientMap.set(proposalId, this._addressToU256(recipient));
        this.amountMap.set(proposalId, amount);
        this.executedMap.set(proposalId, u256.Zero);

        const w: BytesWriter = new BytesWriter(32);
        w.writeU256(proposalId);
        return w;
    }

    // ── Admin: Set Voting Period ─────────────────────────────────────────

    @method({ name: 'blocks', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setVotingPeriod(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const blocks: u256 = calldata.readU256();
        if (blocks < MIN_VOTING_BLOCKS) throw new Revert('Below minimum voting period');
        if (blocks > MAX_VOTING_BLOCKS) throw new Revert('Exceeds maximum voting period');

        this._votingPeriod.value = blocks;

        const w: BytesWriter = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    // ── Public: Vote ────────────────────────────────────────────────────

    @method(
        { name: 'proposalId', type: ABIDataTypes.UINT256 },
        { name: 'support', type: ABIDataTypes.BOOL },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public vote(calldata: Calldata): BytesWriter {
        const proposalId: u256 = calldata.readU256();
        const support: bool = calldata.readBoolean();

        const endBlock: u256 = this.endBlockMap.get(proposalId);
        if (endBlock.isZero()) throw new Revert('Proposal not found');
        if (u256.fromU64(Blockchain.block.number) > endBlock) throw new Revert('Voting ended');

        const voter: Address = Blockchain.tx.sender;

        // Double-vote prevention
        const voteKey: u256 = this._voteKey(proposalId, voter);
        if (!this.voterRecordMap.get(voteKey).isZero()) throw new Revert('Already voted');
        this.voterRecordMap.set(voteKey, u256.One);

        // Get voter's token balance via cross-contract call
        if (this.tokenAddr.isDead()) throw new Revert('Token not set');
        const balCd: BytesWriter = new BytesWriter(4 + 32);
        balCd.writeSelector(encodeSelector('balanceOf(address)'));
        balCd.writeAddress(voter);

        const response = Blockchain.call(this.tokenAddr.value, balCd);
        if (response.data.byteLength < 32) throw new Revert('Balance query failed');
        const voterBalance: u256 = response.data.readU256();
        if (voterBalance.isZero()) throw new Revert('No voting power');

        if (support) {
            this.yesVotesMap.set(proposalId, SafeMath.add(this.yesVotesMap.get(proposalId), voterBalance));
        } else {
            this.noVotesMap.set(proposalId, SafeMath.add(this.noVotesMap.get(proposalId), voterBalance));
        }

        const w: BytesWriter = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    // ── Admin: Execute ──────────────────────────────────────────────────

    @method({ name: 'proposalId', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public executeProposal(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const proposalId: u256 = calldata.readU256();
        const endBlock: u256 = this.endBlockMap.get(proposalId);
        if (endBlock.isZero()) throw new Revert('Proposal not found');
        if (u256.fromU64(Blockchain.block.number) <= endBlock) throw new Revert('Voting not ended');
        if (!this.executedMap.get(proposalId).isZero()) throw new Revert('Already executed');

        const yesVotes: u256 = this.yesVotesMap.get(proposalId);
        const noVotes: u256 = this.noVotesMap.get(proposalId);

        // No quorum — any participation counts. Yes must exceed No.
        if (yesVotes <= noVotes) throw new Revert('Proposal not passed');

        // CEI: mark executed before external calls
        this.executedMap.set(proposalId, u256.One);

        const pool: u256 = this.poolMap.get(proposalId);
        const action: u256 = this.actionMap.get(proposalId);
        const amount: u256 = this.amountMap.get(proposalId);

        // Deduct from pool balance
        if (pool == POOL_RESERVE) {
            const bal: u256 = this._reserveBalance.value;
            if (amount > bal) throw new Revert('Exceeds reserve');
            this._reserveBalance.value = SafeMath.sub(bal, amount);
        } else {
            const bal: u256 = this._communityBalance.value;
            if (amount > bal) throw new Revert('Exceeds community');
            this._communityBalance.value = SafeMath.sub(bal, amount);
        }

        if (action == u256.One) {
            // Action 1: Transfer tokens to recipient
            const recipient: Address = this._u256ToAddress(this.recipientMap.get(proposalId));
            TransferHelper.transfer(this.tokenAddr.value, recipient, amount);
        } else {
            // Action 2: Burn tokens
            const burnCd: BytesWriter = new BytesWriter(4 + 32);
            burnCd.writeSelector(encodeSelector('burn(uint256)'));
            burnCd.writeU256(amount);
            Blockchain.call(this.tokenAddr.value, burnCd, true);
        }

        const w: BytesWriter = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    // ── View ────────────────────────────────────────────────────────────

    @view
    @method({ name: 'proposalId', type: ABIDataTypes.UINT256 })
    @returns(
        { name: 'yesVotes', type: ABIDataTypes.UINT256 },
        { name: 'noVotes', type: ABIDataTypes.UINT256 },
        { name: 'endBlock', type: ABIDataTypes.UINT256 },
        { name: 'snapshotBlock', type: ABIDataTypes.UINT256 },
        { name: 'pool', type: ABIDataTypes.UINT256 },
        { name: 'action', type: ABIDataTypes.UINT256 },
        { name: 'amount', type: ABIDataTypes.UINT256 },
        { name: 'active', type: ABIDataTypes.BOOL },
        { name: 'executed', type: ABIDataTypes.BOOL },
    )
    public proposalInfo(calldata: Calldata): BytesWriter {
        const proposalId: u256 = calldata.readU256();
        const endBlock: u256 = this.endBlockMap.get(proposalId);
        const active: bool = !endBlock.isZero() && u256.fromU64(Blockchain.block.number) <= endBlock;
        const executed: bool = !this.executedMap.get(proposalId).isZero();

        const w: BytesWriter = new BytesWriter(32 * 7 + 2);
        w.writeU256(this.yesVotesMap.get(proposalId));
        w.writeU256(this.noVotesMap.get(proposalId));
        w.writeU256(endBlock);
        w.writeU256(this.snapshotBlockMap.get(proposalId));
        w.writeU256(this.poolMap.get(proposalId));
        w.writeU256(this.actionMap.get(proposalId));
        w.writeU256(this.amountMap.get(proposalId));
        w.writeBoolean(active);
        w.writeBoolean(executed);
        return w;
    }

    @view
    @method()
    @returns(
        { name: 'reserveBalance', type: ABIDataTypes.UINT256 },
        { name: 'communityBalance', type: ABIDataTypes.UINT256 },
        { name: 'proposalCount', type: ABIDataTypes.UINT256 },
    )
    public getState(_calldata: Calldata): BytesWriter {
        const w: BytesWriter = new BytesWriter(32 * 3);
        w.writeU256(this._reserveBalance.value);
        w.writeU256(this._communityBalance.value);
        w.writeU256(this._proposalCount.value);
        return w;
    }

    @view
    @method(
        { name: 'proposalId', type: ABIDataTypes.UINT256 },
        { name: 'voter', type: ABIDataTypes.ADDRESS },
    )
    @returns({ name: 'voted', type: ABIDataTypes.BOOL })
    public hasVoted(calldata: Calldata): BytesWriter {
        const proposalId: u256 = calldata.readU256();
        const voter: Address = calldata.readAddress();
        const w: BytesWriter = new BytesWriter(1);
        w.writeBoolean(!this.voterRecordMap.get(this._voteKey(proposalId, voter)).isZero());
        return w;
    }

    @view
    @method()
    @returns({ name: 'count', type: ABIDataTypes.UINT256 })
    public proposalCount(_calldata: Calldata): BytesWriter {
        const w: BytesWriter = new BytesWriter(32);
        w.writeU256(this._proposalCount.value);
        return w;
    }

    @view
    @method()
    @returns({ name: 'blocks', type: ABIDataTypes.UINT256 })
    public getVotingPeriod(_calldata: Calldata): BytesWriter {
        const w: BytesWriter = new BytesWriter(32);
        w.writeU256(this._votingPeriod.value);
        return w;
    }

    // ── Internal ────────────────────────────────────────────────────────

    private _addressToU256(addr: Address): u256 {
        const bytes: Uint8Array = addr;
        let result: u256 = u256.Zero;
        const len: i32 = bytes.length < 32 ? bytes.length : 32;
        for (let i: i32 = 0; i < len; i++) {
            result = u256.or(result, SafeMath.shl(u256.fromU64(u64(bytes[i])), u32(i * 8)));
        }
        return result;
    }

    private _u256ToAddress(val: u256): Address {
        const bytes = new Uint8Array(32);
        for (let i: i32 = 0; i < 32; i++) {
            const shifted: u256 = SafeMath.shr(val, u32(i * 8));
            bytes[i] = u8(shifted.toU64() & 0xFF);
        }
        return changetype<Address>(bytes);
    }

    private _voteKey(proposalId: u256, voter: Address): u256 {
        const voterU256: u256 = this._addressToU256(voter);
        return u256.xor(SafeMath.mul(proposalId, u256.fromU64(0x100000007)), voterU256);
    }
}
