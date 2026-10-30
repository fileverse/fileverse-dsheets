import { describe, expect, it, vi } from 'vitest';
import { mainnet } from 'viem/chains';
import type { Abi, Hex } from 'viem';

import { fetchAbi, type SmartContractRuntimeDeps } from './reading-utils';

const CONTRACT: Hex = '0x0000000000000000000000000000000000000001';
const ABI: Abi = [
  {
    type: 'function',
    name: 'answer',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
];

/**
 * The ABI reference is storage-agnostic: `fetchAbi` never interprets it, it
 * only hands it to the host's `resolveAbi`. These tests pin that boundary so
 * a backend swap (IPFS → Swarm → anything) stays a host-side concern.
 */
describe('fetchAbi', () => {
  it('resolves a stored ABI through resolveAbi, passing the reference verbatim', async () => {
    const resolveAbi = vi.fn().mockResolvedValue(ABI);
    const deps: SmartContractRuntimeDeps = { resolveAbi, abiCache: {} };

    const abiRef = 'any-opaque-reference:swarm-or-ipfs-or-else';
    const abi = await fetchAbi(
      { contractAddress: CONTRACT, chain: mainnet, abiRef },
      deps,
    );

    expect(abi).toBe(ABI);
    expect(resolveAbi).toHaveBeenCalledWith(abiRef);
  });

  it('caches per contract/chain/reference and skips a second resolve', async () => {
    const resolveAbi = vi.fn().mockResolvedValue(ABI);
    const deps: SmartContractRuntimeDeps = { resolveAbi, abiCache: {} };
    const params = {
      contractAddress: CONTRACT,
      chain: mainnet,
      abiRef: 'ref-1',
    };

    await fetchAbi(params, deps);
    await fetchAbi(params, deps);

    expect(resolveAbi).toHaveBeenCalledTimes(1);
    expect(deps.abiCache[`${CONTRACT}_${mainnet.id}_ref-1`]).toBe(ABI);
  });

  it('resolves again for a different reference to the same contract', async () => {
    const resolveAbi = vi.fn().mockResolvedValue(ABI);
    const deps: SmartContractRuntimeDeps = { resolveAbi, abiCache: {} };

    await fetchAbi(
      { contractAddress: CONTRACT, chain: mainnet, abiRef: 'ref-1' },
      deps,
    );
    await fetchAbi(
      { contractAddress: CONTRACT, chain: mainnet, abiRef: 'ref-2' },
      deps,
    );

    expect(resolveAbi).toHaveBeenCalledTimes(2);
    expect(resolveAbi).toHaveBeenNthCalledWith(2, 'ref-2');
  });
});
