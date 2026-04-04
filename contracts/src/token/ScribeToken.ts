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
    StoredBoolean,
    StoredU256,
} from '@btc-vision/btc-runtime/runtime';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';

// 21B tokens * 10^2 decimals = 2,100,000,000,000
const TOTAL_SUPPLY: u256 = u256.fromString('2100000000000');
const BPS_DENOMINATOR: u256 = u256.fromU32(10000);
const MAX_TAX_BPS: u256 = u256.fromU32(1000); // 10% cap
const DEFAULT_TAX_BPS: u256 = u256.fromU32(300); // 3% default

@final
export class ScribeToken extends OP20 {
    // --- Storage pointers (auto-increment past OP20 internal pointers 0-6) ---
    private readonly rewardsAddrPointer: u16 = Blockchain.nextPointer;
    private readonly rewardsAddr: StoredAddress = new StoredAddress(this.rewardsAddrPointer);

    private readonly taxExemptPointer: u16 = Blockchain.nextPointer;
    private readonly taxExemptMap: AddressMemoryMap = new AddressMemoryMap(this.taxExemptPointer);

    // v2: configurable tax rate in basis points
    private readonly taxRateBpsPointer: u16 = Blockchain.nextPointer;
    private readonly taxRateBps: StoredU256 = new StoredU256(
        this.taxRateBpsPointer,
        EMPTY_POINTER,
    );

    // v2: explicit tax toggle (independent of rewardsAddr)
    private readonly taxEnabledPointer: u16 = Blockchain.nextPointer;
    private readonly taxEnabled: StoredBoolean = new StoredBoolean(
        this.taxEnabledPointer,
        false,
    );

    public constructor() {
        super();
    }

    public override onDeployment(_calldata: Calldata): void {
        // Empty — all initialization done via initialize() post-deploy
    }

    // ── Initialization ──────────────────────────────────────────────────

    @method()
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public initialize(_calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const params = new OP20InitParameters(TOTAL_SUPPLY, 2, 'MyScribe', 'SCRIBE', 'https://myscribe.org/assets/scribe-logo.png');
        this.instantiate(params, true);

        // Mint entire supply to deployer
        this._mint(Blockchain.tx.sender, TOTAL_SUPPLY);

        // Deployer is tax-exempt
        this.taxExemptMap.set(Blockchain.tx.sender, u256.One);

        // Set default tax rate (300 bps = 3%), but tax remains DISABLED
        this.taxRateBps.value = DEFAULT_TAX_BPS;

        const w: BytesWriter = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    // ── Transfer (overridden for tax logic) ─────────────────────────────

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

        // Tax applies only when ALL conditions are met:
        // 1. taxEnabled flag is true (explicit toggle)
        // 2. Rewards address is set (not dead)
        // 3. Neither sender nor receiver is exempt
        if (this.taxEnabled.value && hasRewards && !senderExempt && !receiverExempt) {
            const rateBps: u256 = this.taxRateBps.value;
            taxAmount = SafeMath.div(SafeMath.mul(amount, rateBps), BPS_DENOMINATOR);
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

    // ── Tax Admin Functions (v2) ────────────────────────────────────────

    /**
     * setTaxRate(rateBps) — Set transfer tax rate in basis points.
     * 300 = 3%, max 1000 = 10%. Deployer only.
     */
    @method({ name: 'rateBps', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setTaxRate(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        const rateBps: u256 = calldata.readU256();

        if (rateBps > MAX_TAX_BPS) {
            throw new Revert('Tax rate exceeds maximum (1000 bps)');
        }

        this.taxRateBps.value = rateBps;

        const w: BytesWriter = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    /**
     * getTaxRate() — Public view. Returns current tax rate in basis points.
     */
    @method()
    @returns({ name: 'rateBps', type: ABIDataTypes.UINT256 })
    public getTaxRate(_calldata: Calldata): BytesWriter {
        const w: BytesWriter = new BytesWriter(32);
        w.writeU256(this.taxRateBps.value);
        return w;
    }

    /**
     * enableTax() — Enable transfer tax. Deployer only.
     * Requires rewards address to be set before tax can actually apply.
     */
    @method()
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public enableTax(_calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this.taxEnabled.value = true;

        const w: BytesWriter = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    /**
     * disableTax() — Disable transfer tax. Deployer only.
     */
    @method()
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public disableTax(_calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this.taxEnabled.value = false;

        const w: BytesWriter = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    /**
     * isTaxEnabled() — Public view. Returns whether tax is currently enabled.
     */
    @method()
    @returns({ name: 'enabled', type: ABIDataTypes.BOOL })
    public isTaxEnabled(_calldata: Calldata): BytesWriter {
        const w: BytesWriter = new BytesWriter(1);
        w.writeBoolean(this.taxEnabled.value);
        return w;
    }

    // ── Rewards Address (from v1) ───────────────────────────────────────

    /**
     * setRewardsAddress(addr) — Set the tax destination address.
     * Also auto-exempts the rewards address from tax. Deployer only.
     */
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

    @method()
    @returns({ name: 'rewardsAddress', type: ABIDataTypes.ADDRESS })
    public getRewardsAddress(_calldata: Calldata): BytesWriter {
        const w: BytesWriter = new BytesWriter(32);
        w.writeAddress(this.rewardsAddr.value);
        return w;
    }

    // ── Tax Exempt List (from v1) ───────────────────────────────────────

    /**
     * setTaxExempt(account, exempt) — Add/remove address from tax-exempt list.
     * Deployer only.
     */
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
