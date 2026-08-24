import { optionalEnv } from './env';

function configuredDashScopeBaseURL(region: 'mainland' | 'overseas' = 'overseas') {
  const configured = optionalEnv(`DASHSCOPE_API_BASE_URL_${region.toUpperCase()}`, '')
    .trim()
    .replace(/\/$/, '');
  if (!configured) return '';
  return configured.replace(/\/api\/v1$/, '');
}

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

export function dashscopeEndpointBase(region: 'mainland' | 'overseas' = 'overseas') {
  const configured = configuredDashScopeBaseURL(region);
  if (configured) return configured;
  return region === 'overseas' || dashscopeRegion() === 'intl'
    ? 'https://dashscope-intl.aliyuncs.com'
    : 'https://dashscope.aliyuncs.com';
}
