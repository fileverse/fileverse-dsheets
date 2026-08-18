import type { Abi, Hex } from 'viem';
import type React from 'react';

export enum SupportedChain {
  Ethereum = 'Ethereum',
  Sepolia = 'Sepolia',
  Gnosis = 'Gnosis',
  Base = 'Base',
}

export interface ContractConfig {
  address: Hex;
  abiHash: string;
  network: SupportedChain;
  name: string;
}

export type ContractRegistry = Record<string, ContractConfig>;

export interface NewContractInput {
  name: string;
  address: Hex;
  network: SupportedChain;
  abi: Abi;
}

export type SmartContractEventType =
  | 'query-success'
  | 'query-error'
  | 'contract-added'
  | 'contract-deleted';

export interface SmartContractEvent {
  type: SmartContractEventType;
  contractName?: string;
  functionName?: string;
  chainName?: string;
  errorMessage?: string;
}

export interface SmartContractConfig {
  /** User's persisted private contracts from consumer keystore. Defaults to []. */
  contracts?: ContractConfig[];
  /** RPC URL per chain. Falls back to bundled defaults when omitted. */
  rpcConfig?: Partial<Record<SupportedChain, string>>;
  /** Resolve ABI from stored reference (e.g. an IPFS CID or a Swarm reference — opaque to the package). Required for user-saved contracts with abiHash. */
  resolveAbi?: (abiHash: string) => Promise<Abi>;
  /** Persist a new contract. When omitted, package keeps it in session memory only. */
  onAddContract?: (input: NewContractInput) => Promise<void>;
  /** Remove a persisted contract. When omitted, package removes from session memory only. */
  onDeleteContract?: (contractName: string) => Promise<void>;
  validateAddress?: (
    address: string,
    chain: SupportedChain,
  ) => boolean | Promise<boolean>;
  onSmartContractEvent?: (event: SmartContractEvent) => void;
}

export interface CallerParams {
  abi: Abi;
  contractAddress: Hex;
  chain: import('viem').Chain;
  functionName?: string;
  args?: unknown[];
}

export interface FetchAbiParams {
  contractAddress: Hex;
  chain: import('viem').Chain;
  /** Stored ABI reference (`ContractConfig.abiHash`), resolved via `resolveAbi`. */
  abiRef?: string;
}

export type ParsedFunction = {
  functionName: string;
  output: string;
};

export interface SmartContractListViewProps {
  userSmartContracts: ContractConfig[];
  onDelete: (name: string) => void;
  handleSearch: (searchText: string) => void;
  onOpenImportModal: () => void;
  fetchContractAbi: (contract: ContractConfig) => Promise<Abi>;
  isAuthorized: boolean;
}

export interface MyContractsProps {
  contracts: ContractConfig[];
  onDelete: (name: string) => void;
  fetchContractAbi: (contract: ContractConfig) => Promise<Abi>;
  setActiveTab?: React.Dispatch<React.SetStateAction<string>>;
}

export interface PopularContractsProps {
  contracts: ContractConfig[];
  onInsert: (name: string) => void;
  fetchContractAbi: (contract: ContractConfig) => Promise<Abi>;
}

export interface CodeBlockProps {
  code: React.ReactNode;
  copyText: string;
}

export interface ParameterDescriptionProps {
  paramName: string;
  description: string;
  optional?: boolean;
}
