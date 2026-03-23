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
} from '@btc-vision/btc-runtime/runtime';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';
import { StoredMapU256 } from '@btc-vision/btc-runtime/runtime/storage/maps/StoredMapU256';

// Quorum: 1% of circulating supply (21B * 100 internal units * 1% = 2.1B internal units)
const QUORUM: u256 = u256.fromString('2100000000');
const MAX_PROPOSALS: u256 = u256.fromU64(1000);

// PHASE 2 UPGRADE: Remove onlyOwner from createProposal to enable community proposals with minimum token threshold

@final
export class ScribeGovernance extends OP_NET {
    private readonly tokenAddrPointer: u16 = Blockchain.nextPointer;
    private readonly tokenAddr: StoredAddress = new StoredAddress(this.tokenAddrPointer);

    private readonly proposalCountPointer: u16 = Blockchain.nextPointer;
    private readonly _proposalCount: StoredU256 = new StoredU256(this.proposalCountPointer, EMPTY_POINTER);

    // Per-proposal u256 maps (keyed by proposalId)
    private readonly yesVotesPointer: u16 = Blockchain.nextPointer;
    private readonly yesVotesMap: StoredMapU256 = new StoredMapU256(this.yesVotesPointer);

    private readonly noVotesPointer: u16 = Blockchain.nextPointer;
    private readonly noVotesMap: StoredMapU256 = new StoredMapU256(this.noVotesPointer);

    private readonly endBlockPointer: u16 = Blockchain.nextPointer;
    private readonly endBlockMap: StoredMapU256 = new StoredMapU256(this.endBlockPointer);

    // Target contract stored as u256 (first 32 bytes of address)
    private readonly targetPointer: u16 = Blockchain.nextPointer;
    private readonly targetMap: StoredMapU256 = new StoredMapU256(this.targetPointer);

    // Function selector stored as u256
    private readonly selectorPointer: u16 = Blockchain.nextPointer;
    private readonly selectorMap: StoredMapU256 = new StoredMapU256(this.selectorPointer);

    // Recipient stored as u256
    private readonly recipientPointer: u16 = Blockchain.nextPointer;
    private readonly recipientMap: StoredMapU256 = new StoredMapU256(this.recipientPointer);

    // Amount per proposal
    private readonly amountPointer: u16 = Blockchain.nextPointer;
    private readonly amountMap: StoredMapU256 = new StoredMapU256(this.amountPointer);

    // Executed flag (0 = not executed, 1 = executed)
    private readonly executedPointer: u16 = Blockchain.nextPointer;
    private readonly executedMap: StoredMapU256 = new StoredMapU256(this.executedPointer);

    // Vote record: composite key (proposalId XOR voter) → 1 if voted
    private readonly voterRecordPointer: u16 = Blockchain.nextPointer;
    private readonly voterRecordMap: StoredMapU256 = new StoredMapU256(this.voterRecordPointer);

    public constructor() {
        super();
    }

    public override onDeployment(_calldata: Calldata): void {}

    @method({ name: 'tokenAddress', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setToken(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this.tokenAddr.value = calldata.readAddress();
        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    @method(
        { name: 'target', type: ABIDataTypes.ADDRESS },
        { name: 'selector', type: ABIDataTypes.UINT256 },
        { name: 'recipient', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
        { name: 'durationBlocks', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'proposalId', type: ABIDataTypes.UINT256 })
    public createProposal(calldata: Calldata): BytesWriter {
        // PHASE 2 UPGRADE: Remove onlyOwner to enable community proposals with minimum token threshold
        this.onlyDeployer(Blockchain.tx.sender);

        const target: Address = calldata.readAddress();
        const selector: u256 = calldata.readU256();
        const recipient: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();
        const durationBlocks: u256 = calldata.readU256();

        const count: u256 = this._proposalCount.value;
        if (count >= MAX_PROPOSALS) throw new Revert('Max proposals reached');

        const proposalId: u256 = SafeMath.add(count, u256.One);
        this._proposalCount.value = proposalId;

        const endBlock: u256 = SafeMath.add(u256.fromU64(Blockchain.block.number), durationBlocks);
        this.endBlockMap.set(proposalId, endBlock);
        this.yesVotesMap.set(proposalId, u256.Zero);
        this.noVotesMap.set(proposalId, u256.Zero);
        this.targetMap.set(proposalId, this._addressToU256(target));
        this.selectorMap.set(proposalId, selector);
        this.recipientMap.set(proposalId, this._addressToU256(recipient));
        this.amountMap.set(proposalId, amount);
        this.executedMap.set(proposalId, u256.Zero);

        const w = new BytesWriter(32);
        w.writeU256(proposalId);
        return w;
    }

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

        // Double-vote check using composite key
        const voteKey: u256 = this._voteKey(proposalId, voter);
        if (!this.voterRecordMap.get(voteKey).isZero()) throw new Revert('Already voted');
        this.voterRecordMap.set(voteKey, u256.One);

        // Get voter's token balance
        if (this.tokenAddr.isDead()) throw new Revert('Token not set');
        const balCd = new BytesWriter(4 + 32);
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

        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

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
        const totalVotes: u256 = SafeMath.add(yesVotes, noVotes);

        if (totalVotes < QUORUM) throw new Revert('Quorum not met');
        if (yesVotes <= noVotes) throw new Revert('Proposal not passed');

        // CEI: mark as executed before external call
        this.executedMap.set(proposalId, u256.One);

        // Build cross-contract call
        const target: Address = this._u256ToAddress(this.targetMap.get(proposalId));
        const selector: u256 = this.selectorMap.get(proposalId);
        const recipient: Address = this._u256ToAddress(this.recipientMap.get(proposalId));
        const amount: u256 = this.amountMap.get(proposalId);

        // Encode: selector(4 bytes) + recipient(32 bytes) + amount(32 bytes)
        const cd = new BytesWriter(4 + 32 + 32);
        cd.writeU32(u32(selector.toU64()));
        cd.writeAddress(recipient);
        cd.writeU256(amount);

        Blockchain.call(target, cd, true);

        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    @method({ name: 'proposalId', type: ABIDataTypes.UINT256 })
    @returns(
        { name: 'yesVotes', type: ABIDataTypes.UINT256 },
        { name: 'noVotes', type: ABIDataTypes.UINT256 },
        { name: 'endBlock', type: ABIDataTypes.UINT256 },
        { name: 'active', type: ABIDataTypes.BOOL },
        { name: 'executed', type: ABIDataTypes.BOOL },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    public proposalInfo(calldata: Calldata): BytesWriter {
        const proposalId: u256 = calldata.readU256();
        const endBlock: u256 = this.endBlockMap.get(proposalId);
        const active: bool = !endBlock.isZero() && u256.fromU64(Blockchain.block.number) <= endBlock;
        const executed: bool = !this.executedMap.get(proposalId).isZero();

        const w = new BytesWriter(32 + 32 + 32 + 1 + 1 + 32);
        w.writeU256(this.yesVotesMap.get(proposalId));
        w.writeU256(this.noVotesMap.get(proposalId));
        w.writeU256(endBlock);
        w.writeBoolean(active);
        w.writeBoolean(executed);
        w.writeU256(this.amountMap.get(proposalId));
        return w;
    }

    @method(
        { name: 'proposalId', type: ABIDataTypes.UINT256 },
        { name: 'voter', type: ABIDataTypes.ADDRESS },
    )
    @returns({ name: 'voted', type: ABIDataTypes.BOOL })
    public hasVoted(calldata: Calldata): BytesWriter {
        const proposalId: u256 = calldata.readU256();
        const voter: Address = calldata.readAddress();
        const voteKey: u256 = this._voteKey(proposalId, voter);
        const w = new BytesWriter(1);
        w.writeBoolean(!this.voterRecordMap.get(voteKey).isZero());
        return w;
    }

    @method()
    @returns({ name: 'count', type: ABIDataTypes.UINT256 })
    public proposalCount(_calldata: Calldata): BytesWriter {
        const w = new BytesWriter(32);
        w.writeU256(this._proposalCount.value);
        return w;
    }

    // Convert Address to u256 for storage
    private _addressToU256(addr: Address): u256 {
        const bytes: Uint8Array = addr;
        let result: u256 = u256.Zero;
        const len: i32 = bytes.length < 32 ? bytes.length : 32;
        for (let i: i32 = 0; i < len; i++) {
            result = u256.or(result, SafeMath.shl(u256.fromU64(u64(bytes[i])), u32(i * 8)));
        }
        return result;
    }

    // Convert u256 back to Address
    private _u256ToAddress(val: u256): Address {
        const bytes = new Uint8Array(32);
        for (let i: i32 = 0; i < 32; i++) {
            const shifted: u256 = SafeMath.shr(val, u32(i * 8));
            bytes[i] = u8(shifted.toU64() & 0xFF);
        }
        return changetype<Address>(bytes);
    }

    // Derive unique composite key for vote tracking
    private _voteKey(proposalId: u256, voter: Address): u256 {
        const voterU256: u256 = this._addressToU256(voter);
        return u256.xor(SafeMath.mul(proposalId, u256.fromU64(0x100000007)), voterU256);
    }
}
