import { parseBasicAuth } from './basicAuth.ts';

const hdr = (s: string) => `Basic ${Buffer.from(s).toString('base64')}`;

describe('parseBasicAuth', () => {
  test('parses user and a password containing colons', () => {
    expect(parseBasicAuth(hdr('roku1:pa:ss'))).toEqual({
      user: 'roku1',
      password: 'pa:ss',
    });
  });
  test('rejects missing, wrong scheme and no-colon values', () => {
    expect(parseBasicAuth(undefined)).toBeUndefined();
    expect(parseBasicAuth('Bearer abc')).toBeUndefined();
    expect(parseBasicAuth(hdr('nocolon'))).toBeUndefined();
  });
});
