declare module 'pako' {
  export function deflate(input: Uint8Array, options?: { level?: number }): Uint8Array;
  export class Inflate {
    constructor(options?: { windowBits?: number; chunkSize?: number });
    onData: (chunk: Uint8Array) => void;
    push(data: Uint8Array, flush?: boolean): boolean;
    err: number;
    msg: string;
    ended: boolean;
  }
}
