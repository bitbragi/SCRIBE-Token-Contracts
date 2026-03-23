import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    AddressMemoryMap,
    Blockchain,
    BytesWriter,
    Calldata,
    OP20,
    OP20InitParameters,
    Revert,
    SafeMath,
    StoredAddress,
} from '@btc-vision/btc-runtime/runtime';

// 21B tokens * 10^2 decimals = 2,100,000,000,000
const TOTAL_SUPPLY: u256 = u256.fromString('2100000000000');
const TAX_BPS: u256 = u256.fromU32(300);
const BPS_DENOMINATOR: u256 = u256.fromU32(10000);

@final
export class ScribeToken extends OP20 {
    private readonly rewardsAddrPointer: u16 = Blockchain.nextPointer;
    private readonly rewardsAddr: StoredAddress = new StoredAddress(this.rewardsAddrPointer);

    private readonly taxExemptPointer: u16 = Blockchain.nextPointer;
    private readonly taxExemptMap: AddressMemoryMap = new AddressMemoryMap(this.taxExemptPointer);

    public constructor() {
        super();
    }

    public override onDeployment(_calldata: Calldata): void {
        // Empty — all initialization done via initialize() post-deploy
    }

    @method()
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public initialize(_calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        const params = new OP20InitParameters(TOTAL_SUPPLY, 2, 'SCRIBE', 'SCRIBE', '');
        this.instantiate(params, true);
        this._mint(Blockchain.tx.sender, TOTAL_SUPPLY);
        this.taxExemptMap.set(Blockchain.tx.sender, u256.One);
        const w: BytesWriter = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    protected override _transfer(from: Address, to: Address, amount: u256): void {
        if (from === Address.zero()) throw new Revert('Invalid sender');
        if (to === Address.zero()) throw new Revert('Invalid receiver');

        const balance: u256 = this.balanceOfMap.get(from);
        if (balance < amount) throw new Revert('Insufficient balance');

        const senderExempt: bool = !this.taxExemptMap.get(from).isZero();
        const receiverExempt: bool = !this.taxExemptMap.get(to).isZero();
        const rewardsAddress: Address = this.rewardsAddr.value;
        const hasRewards: bool = !this.rewardsAddr.isDead();

        let taxAmount: u256 = u256.Zero;
        let netAmount: u256 = amount;

        if (!senderExempt && !receiverExempt && hasRewards) {
            taxAmount = SafeMath.div(SafeMath.mul(amount, TAX_BPS), BPS_DENOMINATOR);
            netAmount = SafeMath.sub(amount, taxAmount);
        }

        this.balanceOfMap.set(from, SafeMath.sub(balance, amount));

        const toBal: u256 = this.balanceOfMap.get(to);
        this.balanceOfMap.set(to, SafeMath.add(toBal, netAmount));

        if (taxAmount > u256.Zero) {
            const rewardsBal: u256 = this.balanceOfMap.get(rewardsAddress);
            this.balanceOfMap.set(rewardsAddress, SafeMath.add(rewardsBal, taxAmount));
        }

        this.createTransferredEvent(Blockchain.tx.sender, from, to, amount);
    }

    @method({ name: 'rewardsAddress', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setRewardsAddress(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        const addr: Address = calldata.readAddress();
        this.rewardsAddr.value = addr;
        this.taxExemptMap.set(addr, u256.One);
        const w: BytesWriter = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    @method(
        { name: 'account', type: ABIDataTypes.ADDRESS },
        { name: 'exempt', type: ABIDataTypes.BOOL },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setTaxExempt(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        const account: Address = calldata.readAddress();
        const exempt: bool = calldata.readBoolean();
        this.taxExemptMap.set(account, exempt ? u256.One : u256.Zero);
        const w: BytesWriter = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    @method()
    @returns({ name: 'rewardsAddress', type: ABIDataTypes.ADDRESS })
    public getRewardsAddress(_calldata: Calldata): BytesWriter {
        const w: BytesWriter = new BytesWriter(32);
        w.writeAddress(this.rewardsAddr.value);
        return w;
    }

    @method({ name: 'account', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'exempt', type: ABIDataTypes.BOOL })
    public isTaxExempt(calldata: Calldata): BytesWriter {
        const account: Address = calldata.readAddress();
        const exempt: u256 = this.taxExemptMap.get(account);
        const w: BytesWriter = new BytesWriter(1);
        w.writeBoolean(!exempt.isZero());
        return w;
    }
}
