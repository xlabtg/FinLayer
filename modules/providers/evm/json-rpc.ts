/**
 * Minimal EVM JSON-RPC utilities used by provider adapters.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { ProviderError, ValidationError } from '../../shared/errors/index.js';

export type AbiValue =
  | { type: 'address'; value: string }
  | { type: 'uint16' | 'uint256'; value: bigint | number | string };

export interface EvmTransactionRequest {
  from: string;
  to: string;
  data: string;
  value?: string;
}

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export const MAX_UINT256 = (2n ** 256n) - 1n;

export class EvmJsonRpcClient {
  private requestId = 1;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly providerName: string,
    private readonly rpcUrl: string,
    fetchFn: typeof fetch = fetch
  ) {
    if (!rpcUrl) {
      throw new ValidationError(`${providerName} RPC URL is required`);
    }
    this.fetchFn = fetchFn;
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.request<string>('eth_chainId', []);
      return true;
    } catch {
      return false;
    }
  }

  async sendTransaction(tx: EvmTransactionRequest): Promise<string> {
    const result = await this.request<string>('eth_sendTransaction', [
      {
        from: normalizeAddress(tx.from),
        to: normalizeAddress(tx.to),
        data: normalizeHex(tx.data, 'transaction data'),
        ...(tx.value !== undefined && { value: normalizeHex(tx.value, 'transaction value') }),
      },
    ]);
    return normalizeHex(result, 'transaction hash');
  }

  async call(to: string, data: string, from?: string): Promise<string> {
    return this.request<string>('eth_call', [
      {
        ...(from !== undefined && { from: normalizeAddress(from) }),
        to: normalizeAddress(to),
        data: normalizeHex(data, 'call data'),
      },
      'latest',
    ]);
  }

  private async request<T>(method: string, params: unknown[]): Promise<T> {
    let res: Response;
    const id = this.requestId++;
    try {
      res = await this.fetchFn(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
    } catch (err) {
      throw new ProviderError(this.providerName, `RPC request failed: ${String(err)}`, 'earn');
    }

    if (!res.ok) {
      throw new ProviderError(this.providerName, `RPC HTTP ${res.status}`, 'earn');
    }

    let body: JsonRpcResponse<T>;
    try {
      body = (await res.json()) as JsonRpcResponse<T>;
    } catch (err) {
      throw new ProviderError(this.providerName, `Invalid RPC JSON: ${String(err)}`, 'earn');
    }

    if (body.error) {
      throw new ProviderError(
        this.providerName,
        `RPC ${body.error.code}: ${body.error.message}`,
        'earn'
      );
    }
    if (body.result === undefined) {
      throw new ProviderError(this.providerName, `RPC ${method} returned no result`, 'earn');
    }
    return body.result;
  }
}

export function encodeFunctionData(signature: string, values: AbiValue[]): string {
  const selector = bytesToHex(keccak_256(new TextEncoder().encode(signature))).slice(0, 8);
  return `0x${selector}${values.map(encodeAbiValue).join('')}`;
}

export function decimalToBaseUnits(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new ValidationError(`Invalid decimal amount: ${amount}`);
  }
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > decimals) {
    throw new ValidationError(`Amount has more than ${decimals} decimal places`);
  }
  const digits = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+/, '');
  return digits ? BigInt(digits) : 0n;
}

export function baseUnitsToDecimal(value: bigint | string, decimals: number): string {
  const base = typeof value === 'bigint' ? value : BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const whole = base / scale;
  const fraction = base % scale;
  if (fraction === 0n) {
    return whole.toString();
  }
  return `${whole}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

export function isHexAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

export function normalizeAddress(value: string): string {
  if (!isHexAddress(value)) {
    throw new ValidationError(`Invalid EVM address: ${value}`);
  }
  return value;
}

function encodeAbiValue(value: AbiValue): string {
  if (value.type === 'address') {
    return normalizeAddress(value.value).slice(2).toLowerCase().padStart(64, '0');
  }
  const bits = value.type === 'uint16' ? 16n : 256n;
  return encodeUint(value.value, bits);
}

function encodeUint(value: bigint | number | string, bits: bigint): string {
  const n = typeof value === 'bigint' ? value : BigInt(value);
  if (n < 0n || n >= (2n ** bits)) {
    throw new ValidationError(`Unsigned integer exceeds uint${bits.toString()}`);
  }
  return n.toString(16).padStart(64, '0');
}

function normalizeHex(value: string, label: string): string {
  if (!/^0x[a-fA-F0-9]*$/.test(value)) {
    throw new ValidationError(`Invalid ${label}`);
  }
  return value;
}
