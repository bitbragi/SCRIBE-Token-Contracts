import { Blockchain } from '@btc-vision/btc-runtime/runtime';
import { ScribeTreasury } from './ScribeTreasury';
import { revertOnError } from '@btc-vision/btc-runtime/runtime/abort/abort';

Blockchain.contract = (): ScribeTreasury => {
    return new ScribeTreasury();
};

export * from '@btc-vision/btc-runtime/runtime/exports';

export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
