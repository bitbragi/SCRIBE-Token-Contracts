import { Blockchain } from '@btc-vision/btc-runtime/runtime';
import { ScribeRewardsTreasury } from './ScribeRewardsTreasury';
import { revertOnError } from '@btc-vision/btc-runtime/runtime/abort/abort';

Blockchain.contract = (): ScribeRewardsTreasury => {
    return new ScribeRewardsTreasury();
};

export * from '@btc-vision/btc-runtime/runtime/exports';

export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
