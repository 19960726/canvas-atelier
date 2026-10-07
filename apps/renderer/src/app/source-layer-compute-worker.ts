import { createSourceComputation, type SourceComputeRequest } from './source-layer-computation';

const receive = createSourceComputation((response, transfer) => globalThis.postMessage(response, { transfer }));
globalThis.onmessage = (event: MessageEvent<SourceComputeRequest>) => receive(event.data);
