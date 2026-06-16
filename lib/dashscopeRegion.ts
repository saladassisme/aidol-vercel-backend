import { optionalEnv } from './env';

export function dashscopeRegion(): 'china' | 'intl' {
  const configured = optionalEnv('DASHSCOPE_REGION', '').toLowerCase();
  if (configured === 'intl' || configured === 'international' || configured === 'singapore') {
    return 'intl';
  }
  if (configured === 'china' || configured === 'cn' || configured === 'beijing') {
    return 'china';
  }
  // Default matches the original backend: China endpoint + China API key.
  return 'china';
}

export function dashscopeEndpointBase() {
  return dashscopeRegion() === 'intl'
    ? 'https://dashscope-intl.aliyuncs.com'
    : 'https://dashscope.aliyuncs.com';
}
