import { Blockchain } from '@btc-vision/btc-runtime/runtime';
import { ScribeToken } from './ScribeToken';
import { revertOnError } from '@btc-vision/btc-runtime/runtime/abort/abort';

Blockchain.contract = (): ScribeToken => {
    return new ScribeToken();
};

export * from '@btc-vision/btc-runtime/runtime/exports';

export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
