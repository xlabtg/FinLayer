import { describe, expect, test } from 'bun:test';

import { isValidCryptoAddress } from './index.js';

describe('isValidCryptoAddress', () => {
  test('rejects arbitrary long strings without address structure', () => {
    expect(isValidCryptoAddress('not-a-real-wallet-address')).toBe(false);
  });

  test('validates EVM address format and EIP-55 checksum when mixed case is used', () => {
    expect(isValidCryptoAddress('0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', 'ethereum')).toBe(true);
    expect(isValidCryptoAddress('0xfb6916095ca1df60bB79Ce92cE3Ea74c37c5d359', 'ethereum')).toBe(false);
    expect(isValidCryptoAddress('0x52908400098527886E0F7030069857D2E4169EE', 'ethereum')).toBe(false);
  });

  test('validates Bitcoin base58check addresses', () => {
    expect(isValidCryptoAddress('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA', 'bitcoin')).toBe(true);
    expect(isValidCryptoAddress('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabB', 'bitcoin')).toBe(false);
  });
});
