import { useState, useRef, useEffect } from 'react';
import { Abi, Hex } from 'viem';
import type { ContractConfig } from '../../types/smart-contract';
import { SupportedChain } from '../../types/smart-contract';
import { useAddressValidation } from './use-address-validation';
import { useModalOutsideClick } from './use-modal-outside-click';
import {
  validateAbi,
  parseAbiViewFunctions,
} from '../../utils/smart-contract/reading-utils';

export function useSmartContractModal({
  onSaveContract,
  setShowSmartContractModal,
  registryMapRef,
}: {
  onSaveContract: (
    address: Hex,
    chain: SupportedChain,
    abi: string,
    smartContractName: string,
  ) => Promise<void>;
  setShowSmartContractModal: (show: boolean) => void;
  registryMapRef: React.MutableRefObject<Record<string, ContractConfig>>;
}) {
  const [inputAddress, setInputAddress] = useState<string>('');
  const [selectedChain, setSelectedChain] = useState<SupportedChain>(
    SupportedChain.Ethereum,
  );
  const [formStep, setFormStep] = useState<number>(1);
  const [abiCode, setAbiCode] = useState('');
  const [uploadedFile, setUploadedFile] = useState<any>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<any>(null);
  const [smartContractName, setSmartContractName] = useState('');
  const isImportingRef = useRef(false);

  const formatFileSize = (bytes: any) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const validateJsonFile = (file: any) => {
    return file.type === 'application/json' || file.name.endsWith('.json');
  };

  const readFileContent = (file: any) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          // @ts-expect-error later
          const content = e.target.result;
          JSON.parse(content as string);
          resolve(content);
        } catch (error) {
          reject(new Error('Invalid JSON file'));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  };

  const handleFileUpload = async (file: any) => {
    if (!validateJsonFile(file)) {
      setError({ message: 'Invalid JSON file' });
      return;
    }
    setUploadProgress(0);
    try {
      setUploadedFile({
        name: file?.name,
        size: formatFileSize(file.size),
      });
      setUploadProgress(50);
      const content = await readFileContent(file);
      validateAbi(content);
      setUploadProgress(100);
      setAbiCode(content as string);
      setIsUploading(false);
    } catch (error: any) {
      setError({ message: error.message });
      handleRemoveFile();
    }
  };

  const handleFileInputChange = (e: any) => {
    const file = e.target.files[0];
    if (file) {
      handleFileUpload(file);
    }
  };

  const handleUploadAreaClick = () => {
    fileInputRef.current?.click();
  };

  const handleRemoveFile = () => {
    setUploadedFile(null);
    setUploadProgress(0);
    setIsUploading(false);
    setAbiCode('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const onClose = () => {
    setUploadProgress(0);
    resetValidation();
    setSmartContractName('');
    setFormStep(1);
    setAbiCode('');
    setInputAddress('');
    setUploadedFile(null);
    setShowSmartContractModal(false);
    isImportingRef.current = false;
  };

  const { modalDivRef } = useModalOutsideClick({
    onClose: () => {
      onClose();
    },
    setInputAddress,
    shouldPreventClose: isImportingRef,
  });

  const { isValidAddress, handleAddressChange, resetValidation } =
    useAddressValidation();

  const handleAddressInputChange = (url: string) => {
    setInputAddress(url);
    handleAddressChange(url);
  };

  const onClickProceed = async (abi?: any) => {
    const _abi = abi || abiCode;
    if (!_abi || !smartContractName) return;
    isImportingRef.current = true;
    await onSaveContract(
      inputAddress as Hex,
      selectedChain,
      _abi,
      smartContractName,
    );
    onClose();
  };

  const isVaildJsonType = (abi: string) => {
    try {
      return !!JSON.parse(abi);
    } catch (error) {
      return false;
    }
  };

  const [errorState, setError] = useState<{ message: string } | null>(null);

  useEffect(() => {
    if (abiCode) {
      if (isVaildJsonType(abiCode)) {
        const parse = parseAbiViewFunctions(JSON.parse(abiCode) as Abi);
        if (!parse.length) {
          setError({
            message:
              'Please make sure you are uploading a Json file that contains at least one view function as part of the ABI',
          });
        } else {
          setError(null);
        }
      } else {
        setError({
          message: 'Invalid ABI',
        });
      }
    }
  }, [abiCode]);

  return {
    inputAddress,
    setInputAddress,
    selectedChain,
    setSelectedChain,
    formStep,
    setFormStep,
    abiCode,
    setAbiCode,
    uploadedFile,
    setUploadedFile,
    uploadProgress,
    setUploadProgress,
    isUploading,
    setIsUploading,
    fileInputRef,
    smartContractName,
    setSmartContractName,
    isImportingRef,
    modalDivRef,
    handleFileInputChange,
    handleUploadAreaClick,
    handleRemoveFile,
    handleAddressInputChange,
    onClickProceed,
    isValidAddress,
    registryMapRef,
    errorState,
  };
}
