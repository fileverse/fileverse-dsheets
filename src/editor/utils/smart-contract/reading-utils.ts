import type { Abi, AbiFunction, AbiParameter, Chain, Hex } from 'viem';
import {
  createPublicClient,
  encodeAbiParameters,
  fallback,
  getAbiItem,
  http,
  isAddress,
  toHex,
} from 'viem';
import { packetToBytes } from 'viem/ens';
import type {
  CallerParams,
  ContractConfig,
  ContractRegistry,
  FetchAbiParams,
  ParsedFunction,
  SupportedChain,
} from '../../types/smart-contract';
import {
  CHAIN_NAME_MAP,
  DEFAULT_RPC_URL_MAP,
  RESOLVER_FUNCTION_NAME,
  SUPPORTED_CHAIN_ID_MAP,
  SUPPORTED_VIEM_CHAIN_MAP,
  UNIVERSAL_ENS_RESOLVER_ADDRESS,
} from './constants';
import {
  ContractAbiFetchError,
  ContractNotFound,
  InvalidFunctionName,
  InvalidParams,
  ReadOnlyError,
  UnsupportedChainError,
} from './error-helper';
import { sanitizeValue } from './helpers';

export type SmartContractRuntimeDeps = {
  resolveAbi?: (abiHash: string) => Promise<Abi>;
  rpcConfig?: Partial<Record<SupportedChain, string>>;
  abiCache: Record<string, Abi>;
};

const getRpcUrls = (
  network: SupportedChain,
  rpcConfig?: Partial<Record<SupportedChain, string>>,
): string[] => {
  const fromProp = rpcConfig?.[network];
  if (fromProp) return [fromProp];
  return DEFAULT_RPC_URL_MAP[network] || [];
};

const getPublicClient = (chain: Chain, deps: SmartContractRuntimeDeps) => {
  const network =
    SUPPORTED_CHAIN_ID_MAP[chain.id as keyof typeof SUPPORTED_CHAIN_ID_MAP];
  const rpcUrls = network ? getRpcUrls(network, deps.rpcConfig) : [];
  const transport = fallback(rpcUrls.map((url) => http(url)));
  return createPublicClient({ transport, chain });
};

export const getContractConfig = (
  contractName: string,
  contractRegistry: ContractRegistry,
) => {
  const contractConfig = contractRegistry[contractName];
  if (!contractConfig) {
    throw new ContractNotFound(contractName);
  }
  return contractConfig;
};

export const fetchAbi = async (
  params: FetchAbiParams,
  deps: SmartContractRuntimeDeps,
): Promise<Abi> => {
  const cacheKey = params.abiRef
    ? `${params.contractAddress}_${params.chain.id}_${params.abiRef}`
    : `${params.contractAddress}_${params.chain.id}`;

  if (deps.abiCache[cacheKey]) {
    return deps.abiCache[cacheKey];
  }

  let abi: Abi | undefined;

  if (params.abiRef && deps.resolveAbi) {
    abi = await deps.resolveAbi(params.abiRef);
  } else {
    abi = await fetchVerifiedAbi(params.contractAddress, params.chain);
  }

  if (!abi) {
    throw new ContractAbiFetchError(params.contractAddress, params.chain.id);
  }

  deps.abiCache[cacheKey] = abi;
  return abi;
};

export const validateParams = (
  functionInput: readonly AbiParameter[],
  args: unknown[],
) => {
  try {
    encodeAbiParameters(functionInput ?? [], args);
    return true;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    throw new InvalidParams(message);
  }
};

export const getChainFromChainId = (chainId: number | Hex | string): Chain => {
  if (isNaN(Number(chainId))) {
    const chainName = Object.keys(CHAIN_NAME_MAP).find((value) => {
      const keys = value.split(',');
      return keys.includes(chainId.toString().toLowerCase().trim());
    });

    if (!chainName) throw new UnsupportedChainError(chainId);

    return SUPPORTED_VIEM_CHAIN_MAP[
      CHAIN_NAME_MAP[chainName as keyof typeof CHAIN_NAME_MAP]
    ];
  }
  return SUPPORTED_VIEM_CHAIN_MAP[
    SUPPORTED_CHAIN_ID_MAP[chainId as keyof typeof SUPPORTED_CHAIN_ID_MAP]
  ];
};

export const fetchVerifiedAbi = async (
  contractAddress: Hex,
  chain: Chain,
  exactFields: string[] = ['abi', 'proxyResolution'],
): Promise<Abi> => {
  const baseURL = `https://sourcify.dev/server/v2/contract/${chain.id}/${contractAddress?.trim()}?fields=${exactFields.join(',')}`;

  const response = await fetch(baseURL);
  const data = await response.json();

  if (data?.proxyResolution?.isProxy) {
    const implementationAddress =
      data?.proxyResolution?.implementations?.[0]?.address;

    if (!isAddress(implementationAddress)) return data?.abi as Abi;

    return fetchVerifiedAbi(implementationAddress, chain, ['abi']);
  }

  return data.abi as Abi;
};

export function parseAbiViewFunctions(abi: Abi): ParsedFunction[] {
  const result: ParsedFunction[] = [];

  for (const item of abi) {
    if (
      item.type !== 'function' ||
      (item.stateMutability !== 'view' && item.stateMutability !== 'pure')
    ) {
      continue;
    }

    const fn = item as AbiFunction;
    const inputs = fn.inputs.length
      ? fn.inputs.map(({ type }) => `[${type}]`).join(', ')
      : '';
    const functionName = `${fn.name}${inputs ? `(${inputs})` : '()'}`;
    const output = fn.outputs?.length
      ? fn.outputs.map(({ type }) => type).join(', ')
      : 'void';

    result.push({ functionName, output });
  }

  return result;
}

export const getCallerParamsByAddress = async (
  callSignature: unknown[],
  deps: SmartContractRuntimeDeps,
): Promise<CallerParams> => {
  const [contractAddress, chainId, ...rest] = callSignature as [
    Hex,
    string | number,
    ...unknown[],
  ];

  if (!chainId) {
    throw new Error('Chain ID not found');
  }

  const chain = getChainFromChainId(chainId);
  const abi = await fetchAbi({ contractAddress, chain }, deps);
  const [functionName, ...args] = rest;

  return {
    abi,
    contractAddress,
    chain,
    functionName: functionName as string,
    args,
  };
};

export const getCallerParamsByName = async (
  callSignature: unknown[],
  registry: ContractRegistry,
  deps: SmartContractRuntimeDeps,
): Promise<CallerParams> => {
  const [contractName, functionName, ...args] = callSignature as [
    string,
    string,
    ...unknown[],
  ];
  const contractConfig = getContractConfig(contractName, registry);
  const chain = SUPPORTED_VIEM_CHAIN_MAP[contractConfig.network];

  const abi = await fetchAbi(
    {
      contractAddress: contractConfig.address,
      chain,
      abiRef: contractConfig.abiHash || undefined,
    },
    deps,
  );

  return {
    abi,
    contractAddress: contractConfig.address,
    chain,
    args,
    functionName,
  };
};

export const parseCallSignature = async (
  callSignature: unknown[],
  registry: ContractRegistry,
  deps: SmartContractRuntimeDeps,
): Promise<CallerParams> => {
  if (!callSignature.length) throw new InvalidParams('Invalid call');
  const [contractIdentifier] = callSignature;

  if (isAddress(contractIdentifier as string)) {
    return getCallerParamsByAddress(callSignature, deps);
  }

  return getCallerParamsByName(callSignature, registry, deps);
};

export const executeSmartContractCall = async (
  params: CallerParams,
  deps: SmartContractRuntimeDeps,
) => {
  const { abi, contractAddress, chain, functionName, args } = params;

  if (!functionName) {
    const parsedResponse = [];
    for (const item of abi) {
      if (item.type === 'function') {
        parsedResponse.push({
          name: item.name,
          inputs: item.inputs.map((input) => input.name),
          stateMutability: item.stateMutability,
        });
      }
    }

    const sortedResponse = parsedResponse.sort((a, b) => {
      if (a.stateMutability === 'view') return -1;
      if (b.stateMutability === 'view') return 1;
      return 0;
    });

    const dataRows = sortedResponse.map((item) => ({
      'Function name': item.name,
      Argument: Array.isArray(item.inputs)
        ? item.inputs.join(', ')
        : item.inputs,
      stateMutability: item.stateMutability,
    }));

    return {
      response: dataRows,
      staticInstructions: [
        'How to use this response? Use next syntax for SMARTCONTRACT function',
        'SMARTCONTRACT("contract_address", "functionName", "argument")',
        'Put a needed function and argument from list below',
      ],
    };
  }

  const abiItem = getAbiItem({ abi, name: functionName }) as AbiFunction;
  if (!abiItem) throw new InvalidFunctionName(functionName);
  if (
    !['view', 'pure'].includes(abiItem.stateMutability) &&
    !abiItem.constant
  ) {
    throw new ReadOnlyError(functionName);
  }

  validateParams(abiItem.inputs, args ?? []);

  const publicClient = getPublicClient(chain, deps);
  const result = await publicClient.readContract({
    abi,
    address: contractAddress,
    functionName,
    args: getArgs(args, contractAddress, functionName),
  });

  return {
    response: sanitizeValue(result),
    outputType: abiItem.outputs,
  };
};

const getArgs = (
  args: unknown[] | undefined,
  contractAddress: Hex,
  functionName: string,
) => {
  if (!args) return undefined;

  if (
    functionName === RESOLVER_FUNCTION_NAME &&
    contractAddress === UNIVERSAL_ENS_RESOLVER_ADDRESS
  ) {
    return args.map((arg) => toHex(packetToBytes(arg as string)));
  }

  return args;
};

export const validateAbi = (abi: unknown) => {
  let _abi = abi;
  if (typeof abi === 'string') {
    _abi = JSON.parse(abi);
  }
  if (!Array.isArray(_abi)) {
    throw new Error('Invalid ABI');
  }

  for (const item of _abi) {
    if (typeof item !== 'object' || !item) {
      throw new Error('Invalid ABI');
    }
    if (!('type' in item) || !item.type) {
      throw new Error('Invalid ABI');
    }
  }
};

const hasUnquotedHex = (str: string) =>
  /(^|[\s,[{])0x[0-9a-fA-F]+([\s,\]}]|$)/.test(str);

export const normalizeGridArray = (
  input: unknown[],
  functionName: string,
  abi: Abi,
) => {
  return input.map((item, index) => {
    let result: unknown = item;

    if (
      typeof result === 'string' &&
      ((result.startsWith('[') && result.endsWith(']')) ||
        (result.startsWith('{') && result.endsWith('}')))
    ) {
      try {
        if (hasUnquotedHex(result)) {
          throw new Error('Invalid JSON: unquoted hex value detected');
        }
        let normalized = result.replace(/'/g, '"');
        normalized = normalized.replace(
          /([{,]\s*)([a-zA-Z0-9_]+)\s*:/g,
          '$1"$2":',
        );
        result = JSON.parse(normalized);
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.message === 'Invalid JSON: unquoted hex value detected'
        ) {
          throw err;
        }
      }
    }

    if (Array.isArray(result)) {
      if (
        result.length === 1 &&
        Array.isArray(result[0]) &&
        !Array.isArray(result[0][0])
      ) {
        result = result[0];
      } else if (
        result.every(
          (row) =>
            Array.isArray(row) && row.length === 1 && !Array.isArray(row[0]),
        )
      ) {
        result = result.map((row) => (row as unknown[])[0]);
      }
    }

    const functionABI = abi.find(
      (entry) => entry.type === 'function' && entry.name === functionName,
    ) as AbiFunction | undefined;
    const isInputArray = functionABI?.inputs?.[index]?.type.includes('[]');

    if (Array.isArray(result) && result.length === 1 && !isInputArray) {
      return result[0];
    }

    if (!Array.isArray(result) && isInputArray) {
      return [result];
    }

    return result;
  });
};

export const fetchContractAbi = (
  contract: ContractConfig,
  deps: SmartContractRuntimeDeps,
) => {
  const chain = SUPPORTED_VIEM_CHAIN_MAP[contract.network];
  return fetchAbi(
    {
      contractAddress: contract.address,
      chain,
      abiRef: contract.abiHash || undefined,
    },
    deps,
  );
};

export const isPopularContract = (
  name: string,
  popularNames: Set<string>,
): boolean => popularNames.has(name);
